const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');
const { utils, Server } = require('ssh2');
const { SSHKeySetup, installPublicKeyCommand, passwordPolicyCommand } = require('../src/lib/ssh-key-setup');
const { SSHManager } = require('../src/lib/ssh');

const roots = [];
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novabit-key-test-'));
  roots.push(root);
  return root;
}
const vps = { host: '127.0.0.1', port: '22', username: 'root', password: 'bootstrap', privateKey: '' };

function manager(root, failSave = false) {
  return {
    configDir: root, saves: 0,
    data: { vps: { ...vps }, ispProxy: { address: 'preserve' }, deploy: { uuid: 'preserve' } },
    getEncryption() {},
    load() { return { success: true, data: this.data }; },
    save(data) {
      this.saves++;
      if (failSave) return { success: false, error: 'disk full' };
      this.data = data;
      return { success: true };
    },
  };
}

function fakeSessions({ failConnect = 0, failExec = '', failRollback = false, failHost = false, pause } = {}) {
  const sessions = [];
  const commands = [];
  return {
    sessions, commands,
    createSSH({ hostVerifier }) {
      const index = sessions.length + 1;
      const session = {
        ended: false,
        async connect(config) {
          this.config = config;
          if (!hostVerifier(Buffer.from(index > 1 && failHost ? 'different' : 'host-key'))) return { success: false, error: 'host mismatch' };
          if (index === failConnect) return { success: false, error: 'rejected' };
          if (pause) await pause;
          return { success: true };
        },
        stopReconnect() {},
        disconnect() { this.ended = true; },
        async exec(command) {
          commands.push(command);
          if ((failExec && command.includes(failExec)) || (failRollback && command.includes("action = 'rollback'"))) return { success: false, error: 'injected failure' };
          if (command.includes("action = 'prepare'")) return { success: true, data: 'prepared' };
          if (command.includes("action = 'finish'")) return { success: true, data: '/root/rollback.sh' };
          return { success: true, data: 'ok' };
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

async function testSetupAndFailures() {
  for (const failure of ['', 'connect', 'host', 'install', 'save']) {
    const config = manager(temp(), failure === 'save');
    const fake = fakeSessions({ failConnect: failure === 'connect' ? 2 : 0, failHost: failure === 'host', failExec: failure === 'install' ? 'authorized_keys' : '' });
    const service = new SSHKeySetup({ configManager: config, createSSH: fake.createSSH });
    const result = await service.setup(vps);
    assert.strictEqual(result.success, !failure, failure);
    assert(fake.sessions.every((session) => session.ended));
    assert(!fake.commands.some((command) => command.includes('PasswordAuthentication')));
    if (!failure) {
      assert.strictEqual(config.data.vps.password, '');
      assert.strictEqual(config.data.ispProxy.address, 'preserve');
      assert.strictEqual(config.data.deploy.uuid, 'preserve');
      assert.strictEqual(result.data.verified, true);
      const file = config.data.vps.privateKey;
      const parsed = utils.parseKey(fs.readFileSync(file));
      assert(!(parsed instanceof Error));
      assert.strictEqual(parsed.type, 'ssh-ed25519');
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert(!JSON.stringify(result).includes('BEGIN OPENSSH PRIVATE KEY'));
      assert(!JSON.stringify(result).includes('bootstrap'));
      assert.strictEqual(fake.sessions[1].config.password, '');
    } else {
      assert.strictEqual(config.data.vps.password, 'bootstrap');
      assert.strictEqual(config.saves, failure === 'save' ? 1 : 0);
    }
  }
  const config = manager(temp());
  config.getEncryption = () => { throw new Error('safe storage unavailable'); };
  const fake = fakeSessions();
  const service = new SSHKeySetup({ configManager: config, createSSH: fake.createSSH });
  assert.strictEqual((await service.setup(vps)).success, false);
  assert.strictEqual(fake.sessions.length, 0);
}

function testFailedConfigWriteKeepsOriginal() {
  const root = temp();
  let failure;
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/config.js'), 'utf8');
  const fakeFS = new Proxy(fs, { get(target, key) {
    if (key === 'writeFileSync' || key === 'renameSync') return (...args) => {
      if (failure === key) throw new Error('simulated ' + key + ' failure');
      return target[key](...args);
    };
    return target[key];
  } });
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, Buffer,
    require(name) { return name === 'fs' ? fakeFS : name === 'os' ? { homedir: () => root } : require(name); },
  });
  const config = new module.exports.ConfigManager({ safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text), decryptString: (data) => data.toString(),
  } });
  assert.strictEqual(config.save({ vps }).success, true);
  const original = fs.readFileSync(config.configFile, 'utf8');
  const previous = config.config;
  for (failure of ['writeFileSync', 'renameSync']) {
    assert.strictEqual(config.save({ vps: { ...vps, password: '', privateKey: '/new-key' } }).success, false);
    assert.strictEqual(fs.readFileSync(config.configFile, 'utf8'), original);
    assert.strictEqual(config.config, previous);
    assert(!fs.readdirSync(config.configDir).some((file) => file.startsWith('.config-save-')));
  }
}

async function testExclusiveAndPasswordPolicyRecovery() {
  let resume;
  const pause = new Promise((resolve) => { resume = resolve; });
  const fake = fakeSessions({ pause });
  const service = new SSHKeySetup({ configManager: manager(temp()), createSSH: fake.createSSH });
  const first = service.setup(vps);
  assert.strictEqual((await service.setup(vps)).success, false);
  resume();
  assert.strictEqual((await first).success, true);

  for (const options of [{}, { failConnect: 2 }, { failConnect: 3 }, { failExec: "action = 'finish'" }, { failConnect: 3, failRollback: true }]) {
    const fake = fakeSessions(options);
    const service = new SSHKeySetup({ configManager: manager(temp()), createSSH: fake.createSSH });
    const result = await service.disablePassword({ ...vps, password: '', privateKey: '/key' });
    assert.strictEqual(result.success, !Object.keys(options).length);
    const prepared = fake.commands.some((command) => command.includes("action = 'prepare'"));
    assert.strictEqual(prepared, options.failConnect !== 2);
    const rolledBack = fake.commands.some((command) => command.includes("action = 'rollback'"));
    assert.strictEqual(rolledBack, !result.success && prepared);
    if (options.failRollback) assert(result.error.includes('5 分钟'));
    assert(fake.sessions.every((session) => session.ended));
  }
}

function testPublicKeyAppend() {
  const root = temp();
  const pub = utils.generateKeyPairSync('ed25519').public;
  const command = installPublicKeyCommand(pub).replace('Path(pwd.getpwuid(os.getuid()).pw_dir)', `Path(${JSON.stringify(root)})`);
  fs.mkdirSync(path.join(root, '.ssh'));
  const authorized = path.join(root, '.ssh', 'authorized_keys');
  fs.writeFileSync(authorized, 'existing-key-without-newline');
  execFileSync('/bin/sh', ['-c', command]);
  execFileSync('/bin/sh', ['-c', command]);
  assert.strictEqual(fs.readFileSync(authorized, 'utf8'), 'existing-key-without-newline\n' + pub + '\n');
  assert.strictEqual(fs.statSync(authorized).mode & 0o777, 0o600);
  fs.unlinkSync(authorized);
  const other = path.join(root, 'other');
  fs.writeFileSync(other, 'untouched');
  fs.symlinkSync(other, authorized);
  assert.notStrictEqual(spawnSync('/bin/sh', ['-c', command]).status, 0);
  assert.strictEqual(fs.readFileSync(other, 'utf8'), 'untouched');
}

function testPolicyScriptsWithIsolatedSystemTools() {
  const root = temp();
  const bin = path.join(root, 'bin');
  const etc = path.join(root, 'etc');
  const backups = path.join(root, 'backups');
  fs.mkdirSync(bin);
  fs.mkdirSync(etc);
  fs.writeFileSync(path.join(etc, 'sshd_config'), 'original');
  const target = path.join(etc, 'policy.conf');
  const timer = path.join(root, 'timer');
  const log = path.join(root, 'log');
  function tool(name, body) {
    fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env python3\n' + body, { mode: 0o700 });
  }
  tool('sshd', `import sys, os\nif '-T' in sys.argv:\n enabled = os.path.exists(${JSON.stringify(target)}) and not os.path.exists(${JSON.stringify(path.join(root, 'conflict'))})\n print('pubkeyauthentication yes\\npermitrootlogin prohibit-password\\npasswordauthentication ' + ('no' if enabled else 'yes') + '\\nkbdinteractiveauthentication ' + ('no' if enabled else 'yes'))\n`);
  tool('systemd-run', `from pathlib import Path\nassert not Path(${JSON.stringify(target)}).exists(), 'timer must start before mutation'\nPath(${JSON.stringify(timer)}).touch()\n`);
  tool('systemctl', `import sys\nfrom pathlib import Path\nwith open(${JSON.stringify(log)}, 'a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')\nif sys.argv[1] == 'stop': Path(${JSON.stringify(timer)}).unlink(missing_ok=True)\nif sys.argv[1] == 'is-active' and '.timer' in sys.argv[-1] and not Path(${JSON.stringify(timer)}).exists(): sys.exit(3)\n`);
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, SSH_CONNECTION: '127.0.0.1 12345 127.0.0.1 22' };
  const id = '1234567890abcdef12345678';
  function command(action) {
    return passwordPolicyCommand(id, action)
      .replace('os.getuid() != 0', 'False')
      .replace(`'/root/.novabit-ssh-backups/${id}'`, JSON.stringify(path.join(backups, id)))
      .replace("'/etc/ssh/sshd_config.d/00-000-novabit-key-only.conf'", JSON.stringify(target))
      .replace("'/etc/ssh/sshd_config'", JSON.stringify(path.join(etc, 'sshd_config')));
  }
  const run = (action) => execFileSync('/bin/sh', ['-c', command(action)], { env, encoding: 'utf8' });
  assert.strictEqual(run('prepare').trim(), 'prepared');
  assert(fs.existsSync(timer));
  assert(fs.readFileSync(target, 'utf8').includes('PasswordAuthentication no'));
  assert(run('finish').includes('/rollback.sh'));
  assert(!fs.existsSync(timer));
  run('rollback');
  assert(!fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(path.join(etc, 'sshd_config'), 'utf8'), 'original');
  fs.writeFileSync(target, 'custom-policy');
  fs.writeFileSync(path.join(root, 'conflict'), '');
  assert.notStrictEqual(spawnSync('/bin/sh', ['-c', command('prepare')], { env }).status, 0);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'custom-policy');
  fs.unlinkSync(target);
  fs.rmSync(path.join(backups, id), { recursive: true });
  fs.writeFileSync(path.join(root, 'conflict'), '');
  assert.notStrictEqual(spawnSync('/bin/sh', ['-c', command('prepare')], { env }).status, 0);
  assert(!fs.existsSync(target));
  assert(!fs.existsSync(timer));
}

async function testSettingsWizard() {
  const elements = new Map();
  const notifications = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, listeners: {}, classList: { toggle() {} }, addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(id);
  };
  const config = { vps: { ...vps }, ispProxy: {}, deploy: {} };
  let setupCalls = 0;
  let disableCalls = 0;
  let fail = false;
  const context = {
    document: { getElementById: get },
    window: { App: {
      notify: (message) => notifications.push(message),
      deploy: { updateDeployChecklist() {} },
    }, api: { ssh: {
      async setupKey(input) {
        setupCalls++;
        assert.strictEqual(get('btnSaveVPS').disabled, true);
        assert.strictEqual(get('vpsHost').disabled, true);
        return fail ? { success: false, error: 'verification failed' } : { success: true, data: { vps: { ...input, password: '', privateKey: '/home/test/key' } } };
      },
      async disablePassword() { disableCalls++; return { success: false, cancelled: true }; },
    } } },
  };
  context.App = context.window.App;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/components/settings.js'), 'utf8'), context);
  context.App.settings.init(config);
  context.App.settings.fillForm(config);
  await get('btnSetupSSHKey').listeners.click();
  assert.strictEqual(setupCalls, 1);
  assert.strictEqual(disableCalls, 0);
  assert.strictEqual(config.vps.password, '');
  assert.strictEqual(get('vpsPassword').value, '');
  assert.strictEqual(get('vpsAuthType').value, 'key');
  assert.strictEqual(get('vpsHost').disabled, false);
  assert(get('sshKeyStatus').textContent.includes('独立验证'));
  await get('btnDisableSSHPassword').listeners.click();
  assert.strictEqual(disableCalls, 1);
  fail = true;
  const before = JSON.stringify(config);
  await get('btnSetupSSHKey').listeners.click();
  assert.strictEqual(JSON.stringify(config), before);
  assert(notifications.some((message) => message.includes('verification failed')));
}

// 使用真实 SSH2 服务端验证公钥认证；不连接或修改任何 VPS。
async function testRealSSHHandshake() {
  const config = manager(temp());
  const host = utils.generateKeyPairSync('ed25519');
  let installed;
  let passwords = 0;
  let publicKeys = 0;
  const server = new Server({ hostKeys: [host.private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'bootstrap') {
        passwords++;
        return ctx.accept();
      }
      if (ctx.method === 'publickey' && installed && ctx.key.data.equals(installed.getPublicSSH()) && (!ctx.signature || installed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) {
        publicKeys++;
        return ctx.accept();
      }
      ctx.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        const encoded = info.command.match(/base64.b64decode\('([^']+)'\)/);
        if (encoded) installed = utils.parseKey(Buffer.from(encoded[1], 'base64'));
        stream.write('ok');
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const service = new SSHKeySetup({ configManager: config });
    const result = await service.setup({ ...vps, port: String(server.address().port) });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(passwords, 1);
    assert(publicKeys >= 1);
    const mismatch = new SSHManager({ hostVerifier: () => false });
    try { assert.strictEqual((await mismatch.connect(config.data.vps)).success, false); }
    finally { mismatch.disconnect(); }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  try {
    for (const test of [testSetupAndFailures, testFailedConfigWriteKeepsOriginal, testExclusiveAndPasswordPolicyRecovery, testPublicKeyAppend, testPolicyScriptsWithIsolatedSystemTools, testSettingsWizard, testRealSSHHandshake]) {
      await test();
      console.log('✓ ' + test.name);
    }
    console.log('SSH 密钥向导测试通过');
  } finally {
    roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
