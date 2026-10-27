const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { utils } = require('ssh2');
const { SSHManager } = require('./ssh');

function pythonCommand(source) {
  return `python3 - << 'NOVABIT_PY'\n${source}\nNOVABIT_PY`;
}

function installPublicKeyCommand(publicKey) {
  const encoded = Buffer.from(publicKey.trim() + '\n').toString('base64');
  return pythonCommand(`import os, pwd, base64
from pathlib import Path
home = Path(pwd.getpwuid(os.getuid()).pw_dir)
directory = home / '.ssh'
if directory.is_symlink():
    raise RuntimeError('.ssh 不能是软链接，请手动配置')
directory.mkdir(mode=0o700, exist_ok=True)
os.chmod(directory, 0o700)
target = directory / 'authorized_keys'
if target.is_symlink():
    raise RuntimeError('authorized_keys 不能是软链接，请手动配置')
key = base64.b64decode('${encoded}')
fd = os.open(str(target), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'r+b') as stream:
    import fcntl
    fcntl.flock(stream, fcntl.LOCK_EX)
    content = stream.read()
    if key.strip() not in content.splitlines():
        stream.write((b'\\n' if content and not content.endswith(b'\\n') else b'') + key)
        stream.flush()
        os.fsync(stream.fileno())
    os.fchmod(stream.fileno(), 0o600)
print('公钥已安装')`);
}

// 仅处理支持 Include 和 systemd 的 Linux。定时回滚在写入配置前启动。
function passwordPolicyCommand(id, action) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('无效的操作标识');
  if (!['prepare', 'finish', 'rollback'].includes(action)) throw new Error('无效的策略操作');
  const source = `import os, shutil, subprocess, socket
from pathlib import Path
if os.getuid() != 0:
    raise RuntimeError('关闭密码登录需要 root 权限；普通用户可继续使用密钥登录')
sshd = shutil.which('sshd') or '/usr/sbin/sshd'
directory = Path('/root/.novabit-ssh-backups/${id}')
target = Path('/etc/ssh/sshd_config.d/00-000-novabit-key-only.conf')
unit = 'novabit-ssh-${id}'
def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, text=True).strip()
def service_name():
    for name in ('ssh', 'sshd'):
        if subprocess.run(['systemctl', 'is-active', '--quiet', name]).returncode == 0:
            return name
    raise RuntimeError('未发现可重载的 systemd SSH 服务')
def policy():
    connection = os.environ.get('SSH_CONNECTION', '').split()
    if len(connection) != 4:
        raise RuntimeError('无法确认当前 SSH 连接条件')
    client, _, local, port = connection
    context = 'user=root,host=' + socket.getfqdn(client) + ',addr=' + client + ',laddr=' + local + ',lport=' + port
    for args in ([], ['-C', context]):
        values = dict(line.split(' ', 1) for line in run(sshd, '-T', *args).splitlines() if ' ' in line)
        if values.get('passwordauthentication') != 'no' or values.get('kbdinteractiveauthentication') != 'no' or values.get('pubkeyauthentication') != 'yes' or values.get('permitrootlogin') not in ('prohibit-password', 'without-password', 'yes'):
            return False
    return True
action = '${action}'
if action == 'prepare':
    run(sshd, '-t')
    if policy():
        print('already-disabled')
    else:
        if target.exists() or target.is_symlink():
            raise RuntimeError('已存在 NovaBit SSH 策略文件，请先检查服务器配置')
        if not target.parent.is_dir():
            raise RuntimeError('服务器不支持 sshd_config.d，请手动设置密码策略')
        service = service_name()
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        os.chmod(directory.parent, 0o700)
        shutil.copy2('/etc/ssh/sshd_config', directory / 'sshd_config.before')
        rollback = directory / 'rollback.sh'
        rollback.write_text('#!/bin/sh\\nset -eu\\nif [ -f ' + str(target) + " ] && grep -Fxq '# NovaBit transaction ${id}' " + str(target) + '; then\\nrm -f ' + str(target) + '\\nfi\\n' + sshd + ' -t\\nsystemctl reload ' + service + '\\n')
        rollback.chmod(0o700)
        run('systemd-run', '--unit=' + unit, '--on-active=5m', '/bin/sh', str(rollback))
        run('systemctl', 'is-active', unit + '.timer')
        try:
            fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write('# NovaBit transaction ${id}\\nPubkeyAuthentication yes\\nPermitRootLogin prohibit-password\\nPasswordAuthentication no\\nKbdInteractiveAuthentication no\\n')
            run(sshd, '-t')
            if not policy():
                raise RuntimeError('服务器已有配置覆盖此策略，已回滚；请手动检查 Include / Match / 配置优先级')
            run('systemctl', 'reload', service)
        except Exception:
            run('/bin/sh', str(rollback))
            subprocess.run(['systemctl', 'stop', unit + '.timer'])
            raise
        print('prepared')
elif action == 'finish':
    run('systemctl', 'is-active', unit + '.timer')
    run('systemctl', 'stop', unit + '.timer', unit + '.service')
    if not policy():
        run('/bin/sh', str(directory / 'rollback.sh'))
        raise RuntimeError('密码策略验证失败，已回滚')
    print(str(directory / 'rollback.sh'))
elif action == 'rollback':
    rollback = directory / 'rollback.sh'
    if rollback.exists():
        run('/bin/sh', str(rollback))
        subprocess.run(['systemctl', 'stop', unit + '.timer'])
    print('rolled-back')
else:
    raise RuntimeError('无效的操作')`;
  return pythonCommand(source);
}

class SSHKeySetup {
  constructor({ configManager, createSSH = (options) => new SSHManager(options), generateKeyPair } = {}) {
    this.configManager = configManager;
    this.createSSH = createSSH;
    this.generateKeyPair = generateKeyPair || (() => new Promise((resolve, reject) => {
      utils.generateKeyPair('ed25519', { comment: 'novabit-proxy' }, (error, keys) => error ? reject(error) : resolve(keys));
    }));
    this.busy = false;
  }

  async exclusive(operation) {
    if (this.busy) return { success: false, error: 'SSH 密钥设置正在进行，请等待完成' };
    this.busy = true;
    try { return await operation(); }
    catch (error) { return { success: false, error: error.message }; }
    finally { this.busy = false; }
  }

  validate(vps) {
    if (!vps || typeof vps.host !== 'string' || !vps.host.trim() || typeof vps.username !== 'string' || !vps.username.trim()) {
      throw new Error('请填写 VPS 主机地址和用户名');
    }
    if (!/^\d+$/.test(String(vps.port || 22)) || +vps.port < 1 || +vps.port > 65535) throw new Error('SSH 端口无效');
  }

  async connect(session, config) {
    const result = await session.connect(config);
    session.stopReconnect();
    if (!result.success) throw new Error('SSH 认证失败：' + result.error);
  }

  async exec(session, command) {
    const result = await session.exec(command, { timeoutMs: 60000 });
    if (!result.success) throw new Error(result.error || '远程命令执行失败');
    return result.data;
  }

  sessions() {
    let hostKey;
    const bootstrap = this.createSSH({ hostVerifier: (key) => { hostKey = Buffer.from(key); return true; } });
    const verified = () => {
      if (!hostKey) throw new Error('无法取得服务器主机密钥，已停止设置');
      return this.createSSH({ hostVerifier: (key) => Buffer.from(key).equals(hostKey) });
    };
    return { bootstrap, verified };
  }

  setup(vps) {
    return this.exclusive(async () => {
      this.validate(vps);
      if (!vps.password && !vps.privateKey) throw new Error('请先填写密码或已有私钥路径');
      // 先验证安全存储可用，防止远端安装后才发现无法保存。
      this.configManager.getEncryption();
      const { bootstrap, verified } = this.sessions();
      let probe;
      let keyPath;
      let keyWritten = false;
      try {
        await this.connect(bootstrap, vps);
        const keys = await this.generateKeyPair();
        const directory = path.join(this.configManager.configDir, 'ssh-keys');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        keyPath = path.join(directory, 'id_ed25519_' + crypto.randomBytes(12).toString('hex'));
        fs.writeFileSync(keyPath, keys.private, { flag: 'wx', mode: 0o600 });
        keyWritten = true;
        fs.writeFileSync(keyPath + '.pub', keys.public + '\n', { flag: 'wx', mode: 0o600 });
        await this.exec(bootstrap, installPublicKeyCommand(keys.public));
        const keyConfig = { host: vps.host.trim(), port: String(vps.port || 22), username: vps.username.trim(), password: '', privateKey: keyPath };
        probe = verified();
        await this.connect(probe, keyConfig);
        await this.exec(probe, 'printf novabit-key-verified');
        const loaded = this.configManager.load();
        if (!loaded.success) throw new Error('读取配置失败：' + loaded.error);
        const saved = this.configManager.save({ ...loaded.data, vps: keyConfig });
        if (!saved.success) throw new Error('保存配置失败：' + saved.error);
        return { success: true, data: { vps: keyConfig, verified: true } };
      } catch (error) {
        // 可能已安装公钥，保留专用密钥便于手动恢复；从不关闭密码认证。
        return { success: false, error: error.message + (keyWritten ? `。原登录方式未更改；新密钥保留在 ${keyPath}` : '') };
      } finally {
        if (probe) probe.disconnect();
        bootstrap.disconnect();
      }
    });
  }

  disablePassword(vps) {
    return this.exclusive(async () => {
      this.validate(vps);
      if (!vps.privateKey || vps.password) throw new Error('请先保存并验证 SSH 密钥登录');
      const { bootstrap, verified } = this.sessions();
      const id = crypto.randomBytes(12).toString('hex');
      let probe;
      let attempted = false;
      try {
        await this.connect(bootstrap, { ...vps, password: '' });
        // 写入前也验证独立连接，不能依赖界面缓存的“成功”状态。
        probe = verified();
        await this.connect(probe, { ...vps, password: '' });
        probe.disconnect();
        attempted = true;
        const prepared = await this.exec(bootstrap, passwordPolicyCommand(id, 'prepare'));
        if (prepared === 'already-disabled') return { success: true, data: { alreadyDisabled: true } };
        probe = verified();
        await this.connect(probe, { ...vps, password: '' });
        const rollbackPath = await this.exec(probe, passwordPolicyCommand(id, 'finish'));
        return { success: true, data: { rollbackPath } };
      } catch (error) {
        let recovery = '';
        if (attempted) {
          try {
            await this.exec(bootstrap, passwordPolicyCommand(id, 'rollback'));
            recovery = '；已恢复原密码策略';
          } catch (_) { recovery = '；无法确认即时回滚，5 分钟定时恢复可能仍在等待，请通过服务商控制台核实'; }
        }
        return { success: false, error: error.message + recovery };
      } finally {
        if (probe) probe.disconnect();
        bootstrap.disconnect();
      }
    });
  }
}

module.exports = { SSHKeySetup, installPublicKeyCommand, passwordPolicyCommand };
