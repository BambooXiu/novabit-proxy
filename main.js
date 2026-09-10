const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const QRCode = require('qrcode');
const { SSHManager } = require('./src/lib/ssh');
const { ConfigManager } = require('./src/lib/config');
const {
  createServerConfig,
  generateClientConfig,
  generateOptimizeScript,
} = require('./src/lib/xray-config');

let mainWindow;
const sshManager = new SSHManager();
const configManager = new ConfigManager({ safeStorage });
const REMOTE_COMMAND_TIMEOUT = {
  standard: 30000,
  service: 60000,
  package: 300000,
  systemUpgrade: 600000,
};
const XRAY_CONFIG_PATH = '/usr/local/etc/xray/config.json';
const XRAY_MODES_DIR = '/usr/local/etc/xray/modes';
let activeXrayOperation = null;

async function runExclusiveXrayOperation(name, operation) {
  if (activeXrayOperation) {
    return { success: false, error: `Xray 正在执行“${activeXrayOperation}”，请等待完成后再${name}` };
  }

  activeXrayOperation = name;
  try {
    return await operation();
  } finally {
    activeXrayOperation = null;
  }
}

function createConfigWriteCommand(targetPath, content) {
  // 临时文件必须以 .json 结尾：Xray-core 1.8+ 通过 filepath.Ext() 识别配置格式，
  // 后缀不是 .json 会直接退出非 0（例如 code 23）。
  return `set -eu
TARGET_CONFIG='${targetPath}'
TEMP_CONFIG="${targetPath}.$$.next.json"
cleanup() { rm -f "$TEMP_CONFIG"; }
trap cleanup EXIT
cat > "$TEMP_CONFIG" << 'XRAYEOF'
${content}
XRAYEOF
xray run -test -config "$TEMP_CONFIG"
mv "$TEMP_CONFIG" "$TARGET_CONFIG"
trap - EXIT`;
}

function createConfigActivationCommand(sourcePath, { discoverLegacyProxy = false } = {}) {
  // 临时文件必须以 .json 结尾：Xray-core 1.8+ 通过 filepath.Ext() 识别配置格式。
  const legacyProxyLookup = discoverLegacyProxy ? `
if [ ! -f "$SOURCE_CONFIG" ]; then
  SOURCE_CONFIG="$(find '${XRAY_MODES_DIR}' -maxdepth 1 -type f -name '*.json' ! -name 'direct.json' -print -quit)"
fi
test -n "$SOURCE_CONFIG"` : '';
  return `set -eu
SOURCE_CONFIG='${sourcePath}'
${legacyProxyLookup}
ACTIVE_CONFIG='${XRAY_CONFIG_PATH}'
TEMP_CONFIG="${XRAY_CONFIG_PATH}.$$.next.json"
BACKUP_CONFIG="${XRAY_CONFIG_PATH}.backup.$$"
cleanup() { rm -f "$TEMP_CONFIG"; }
trap cleanup EXIT
test -f "$SOURCE_CONFIG"
cp "$SOURCE_CONFIG" "$TEMP_CONFIG"
xray run -test -config "$TEMP_CONFIG"
if [ -f "$ACTIVE_CONFIG" ]; then
  cp "$ACTIVE_CONFIG" "$BACKUP_CONFIG"
fi
mv "$TEMP_CONFIG" "$ACTIVE_CONFIG"
if systemctl restart xray && sleep 2 && systemctl is-active --quiet xray; then
  rm -f "$BACKUP_CONFIG"
  trap - EXIT
  exit 0
fi
echo '新配置启动失败，正在恢复上一个可用配置' >&2
if [ -f "$BACKUP_CONFIG" ]; then
  mv "$BACKUP_CONFIG" "$ACTIVE_CONFIG"
  systemctl restart xray || true
else
  rm -f "$ACTIVE_CONFIG"
  systemctl stop xray || true
fi
exit 1`;
}

function createOptimizeRestartCommand() {
  // 修复三处问题：
  // 1. sleep 2 → 3：给优化后首次启动多预留 1 秒，避免慢启动机器误判
  // 2. 恢复分支原本写 `if ! restart || ! sleep 2 || ! is-active` —— `! sleep 2` 永远为真
  //    （sleep 退出码 0，!0=1），即使 Xray 实际启动成功也会误判。现把 sleep 单独执行，
  //    仅用于等待启动，不计入失败判定。
  // 3. 回滚成功后必须 exit 1 而不是 exit 0：优化本身失败了，返回 0 会让上层报"修复完成"，
  //    把"已回滚"伪装成成功。回滚路径保留 .optimization-backup 供排查。
  return `set -u
ACTIVE_CONFIG='${XRAY_CONFIG_PATH}'
BACKUP_CONFIG='${XRAY_CONFIG_PATH}.optimization-backup'
if systemctl restart xray && sleep 3 && systemctl is-active --quiet xray; then
  rm -f "$BACKUP_CONFIG"
  exit 0
fi
echo '优化后的配置启动失败，正在恢复上一个可用配置' >&2
if [ ! -f "$BACKUP_CONFIG" ]; then
  echo '找不到优化前备份，无法自动恢复' >&2
  exit 1
fi
if ! cp "$BACKUP_CONFIG" "$ACTIVE_CONFIG"; then
  echo '恢复优化前配置失败，请检查磁盘和文件权限' >&2
  exit 1
fi
# cp 覆盖已存在文件会保留目标的权限。若原文件权限已损坏（如 0600，
# xray 以 nobody 运行读不了会直接启动失败），恢复后必须重置为 0644。
chmod 644 "$ACTIVE_CONFIG" 2>/dev/null || true
if ! systemctl restart xray; then
  echo '恢复后重启 Xray 失败，请检查 systemctl status xray' >&2
  exit 1
fi
sleep 3
if ! systemctl is-active --quiet xray; then
  echo '恢复后的 Xray 服务仍未运行，请检查 systemctl status xray' >&2
  exit 1
fi
# 回滚成功也必须返回非 0：本次优化并未生效，返回 0 会让上层提示"修复完成"，
# 把"失败已回滚"伪装成成功，用户会误以为优化已应用。
echo '已自动恢复到优化前的配置，Xray 服务当前正常运行，但本次优化未生效' >&2
exit 1`;
}

function createKernelNetworkTuningCommand() {
  // 逐条应用并容错：OpenVZ / LXC 等受限内核不支持修改个别 sysctl 参数，
  // 原实现用 `sysctl -p` 整体应用，任一参数不支持就让整个流程在第 1 步失败，
  // 后续配置优化全被阻断。现在不支持的项跳过并提示，只把成功的项写入持久化配置。
  return `set -u
TARGET_CONFIG='/etc/sysctl.d/99-vps-proxy-manager.conf'
TEMP_CONFIG='/etc/sysctl.d/99-vps-proxy-manager.conf.next.$$'
cleanup() { rm -f "$TEMP_CONFIG"; }
trap cleanup EXIT
mkdir -p /etc/sysctl.d
: > "$TEMP_CONFIG"
while IFS= read -r line; do
  if sysctl -w "$line" >/dev/null 2>&1; then
    echo "$line" >> "$TEMP_CONFIG"
  else
    echo "内核不支持该参数，已跳过: $line" >&2
  fi
done << 'SYSCTLEOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.tcp_fastopen=3
SYSCTLEOF
mv "$TEMP_CONFIG" "$TARGET_CONFIG"
trap - EXIT`;
}

function createIspVerificationCommand(ispProxyConfig) {
  const address = String(ispProxyConfig?.address || '').trim();
  const port = Number.parseInt(String(ispProxyConfig?.port || ''), 10);
  const username = String(ispProxyConfig?.username || '');
  const password = String(ispProxyConfig?.password || '');

  if (!/^[a-zA-Z0-9.-]+$/.test(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ISP 代理地址或端口格式无效');
  }

  const endpoint = Buffer.from(`${address}:${port}`, 'utf8').toString('base64');
  const credentials = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `set -eu
PROXY_ENDPOINT="$(printf '%s' '${endpoint}' | base64 -d)"
PROXY_CREDENTIALS="$(printf '%s' '${credentials}' | base64 -d)"
curl -fsS --max-time 10 --socks5-hostname "$PROXY_ENDPOINT" --proxy-user "$PROXY_CREDENTIALS" https://ipinfo.io/ip`;
}

function createSwitchScript() {
  return `#!/bin/bash
set -eu
CONFIG_DIR="${XRAY_MODES_DIR}"
ACTIVE_CONFIG="${XRAY_CONFIG_PATH}"

activate_mode() {
  SOURCE_CONFIG="$1"
  # 临时文件必须以 .json 结尾：Xray-core 1.8+ 通过 filepath.Ext() 识别配置格式。
  TEMP_CONFIG="${XRAY_CONFIG_PATH}.$$.next.json"
  BACKUP_CONFIG="${XRAY_CONFIG_PATH}.backup.$$"
  cleanup() { rm -f "$TEMP_CONFIG"; }
  trap cleanup RETURN
  test -f "$SOURCE_CONFIG"
  cp "$SOURCE_CONFIG" "$TEMP_CONFIG"
  xray run -test -config "$TEMP_CONFIG"
  if [ -f "$ACTIVE_CONFIG" ]; then
    cp "$ACTIVE_CONFIG" "$BACKUP_CONFIG"
  fi
  mv "$TEMP_CONFIG" "$ACTIVE_CONFIG"
  if systemctl restart xray && sleep 2 && systemctl is-active --quiet xray; then
    rm -f "$BACKUP_CONFIG"
    return 0
  fi
  echo '新配置启动失败，正在恢复上一个可用配置' >&2
  if [ -f "$BACKUP_CONFIG" ]; then
    mv "$BACKUP_CONFIG" "$ACTIVE_CONFIG"
    systemctl restart xray || true
  else
    rm -f "$ACTIVE_CONFIG"
    systemctl stop xray || true
  fi
  return 1
}

case "$1" in
  proxy|direct) activate_mode "$CONFIG_DIR/$1.json" && echo "switched to $1" ;;
  status) proto=$(jq -r '.outbounds[0].protocol' "$ACTIVE_CONFIG" 2>/dev/null); echo "$proto" ;;
  verify) curl -s --max-time 10 https://ipinfo.io/ip ;;
  *) echo "usage: xray-switch {proxy|direct|status|verify}"; exit 2 ;;
esac`;
}

// SSH 状态变化推送到渲染进程
sshManager.onStatusChange = (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:status-change', status);
  }
};

// ==================== Error Boundary ====================
function wrapHandler(handler) {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      console.error('IPC Handler Error:', error);
      return { success: false, error: error.message || 'Unknown error' };
    }
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 800,
    minHeight: 580,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile('src/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sshManager.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

// ==================== IPC Handlers ====================

// 配置管理
ipcMain.handle('config:load', wrapHandler(async () => {
  return configManager.load();
}));

ipcMain.handle('config:save', wrapHandler(async (event, config) => {
  return configManager.save(config);
}));

// SSH 连接
ipcMain.handle('ssh:test', wrapHandler(async (event, vpsConfig) => {
  return sshManager.testConnection(vpsConfig);
}));

ipcMain.handle('ssh:connect', wrapHandler(async (event, vpsConfig) => {
  return sshManager.connect(vpsConfig);
}));

ipcMain.handle('ssh:disconnect', wrapHandler(async () => {
  return sshManager.disconnect();
}));

// Xray 管理
ipcMain.handle('xray:status', wrapHandler(async () => {
  return sshManager.exec('systemctl is-active xray && systemctl is-enabled xray');
}));

ipcMain.handle('xray:current-mode', wrapHandler(async () => {
  return sshManager.exec(
    'if [ -f /usr/local/etc/xray/config.json ]; then ' +
    'proto=$(python3 -c "import json; print(json.load(open(\'/usr/local/etc/xray/config.json\'))[\'outbounds\'][0][\'protocol\'])" 2>/dev/null || echo "unknown"); ' +
    'echo "$proto"; else echo "not_installed"; fi'
  );
}));

ipcMain.handle('xray:switch-mode', wrapHandler((event, mode) => runExclusiveXrayOperation('切换模式', async () => {
  if (mode !== 'proxy' && mode !== 'direct') {
    return { success: false, error: 'Invalid mode' };
  }
  const cmd = createConfigActivationCommand(`${XRAY_MODES_DIR}/${mode}.json`, {
    discoverLegacyProxy: mode === 'proxy',
  });
  return sshManager.exec(cmd);
})));

ipcMain.handle('xray:verify-ip', wrapHandler(async () => {
  return sshManager.exec('curl -s --max-time 10 https://ipinfo.io/ip');
}));

ipcMain.handle('xray:verify-isp-proxy', wrapHandler(async (event, ispProxyConfig) => {
  const cmd = createIspVerificationCommand(ispProxyConfig);
  return sshManager.exec(cmd);
}));

// 一键部署
ipcMain.handle('deploy:run', wrapHandler((event, config) => runExclusiveXrayOperation('部署', async () => {
  const { vps, ispProxy, xray } = config;

  const steps = [];
  const runStep = async (name, cmd, timeoutMs = REMOTE_COMMAND_TIMEOUT.standard) => {
    const result = await sshManager.exec(cmd, { timeoutMs });
    steps.push({ name, result });
    if (!result.success) {
      throw new Error(`${name}失败: ${result.error || '远端命令未成功执行'}`);
    }
    return result;
  };

  try {
    // Step 1: 基础配置
    await runStep('更新软件包索引', 'apt update -y', REMOTE_COMMAND_TIMEOUT.package);
    await runStep('安装工具', 'apt install -y curl wget unzip jq', REMOTE_COMMAND_TIMEOUT.package);

    // Step 1.5: 启用 BBR 和 TCP Fast Open，与 Xray sockopt 保持一致。
    await runStep('启用 BBR 与 TCP Fast Open', createKernelNetworkTuningCommand());

    // Step 2: 安装 Xray
    await runStep('安装 Xray', 'bash <(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)', REMOTE_COMMAND_TIMEOUT.package);

    // Step 3: 生成凭证
    const uuid = await runStep('生成 UUID', 'xray uuid');
    const keys = await runStep('生成密钥对', 'xray x25519');
    const shortId = await runStep('生成 shortId', 'openssl rand -hex 8');

    // 解析密钥
    const keysData = keys.data || '';
    const privateKey = keysData.match(/PrivateKey:\s*(\S+)/i)?.[1] || keysData.match(/Private key:\s*(\S+)/i)?.[1] || '';
    const publicKey = keysData.match(/Password \(PublicKey\):\s*(\S+)/i)?.[1] || keysData.match(/Public key:\s*(\S+)/i)?.[1] || '';

    // Step 4: 创建配置目录
    await runStep('创建配置目录', 'mkdir -p /usr/local/etc/xray/modes');

    // Step 5: 生成 ISP 代理模式配置
    const uuidStr = (uuid.data || '').trim();
    const shortIdStr = (shortId.data || '').trim();

    const ispProxyConfig = JSON.stringify(createServerConfig({
      mode: 'proxy',
      uuid: uuidStr,
      privateKey,
      shortId: shortIdStr,
      ispProxy,
    }), null, 2);

    // Step 6: 生成直连模式配置
    const directConfig = JSON.stringify(createServerConfig({
      mode: 'direct',
      uuid: uuidStr,
      privateKey,
      shortId: shortIdStr,
      ispProxy,
    }), null, 2);

    // 先在临时文件校验，再原子替换模式配置，避免留下无法启动的 JSON。
    await runStep('写入并校验 ISP 代理配置', createConfigWriteCommand(`${XRAY_MODES_DIR}/proxy.json`, ispProxyConfig));
    await runStep('写入并校验直连配置', createConfigWriteCommand(`${XRAY_MODES_DIR}/direct.json`, directConfig));

    // Step 7: 配置防火墙
    await runStep('配置防火墙', 'apt install -y ufw && ufw allow 22/tcp && ufw allow 443/tcp && ufw --force enable', REMOTE_COMMAND_TIMEOUT.package);

    // Step 8: 校验后启用初始配置；新配置启动失败时自动恢复安装器原有配置。
    await runStep(
      '启用并启动 Xray',
      createConfigActivationCommand(`${XRAY_MODES_DIR}/proxy.json`, { discoverLegacyProxy: true }),
      REMOTE_COMMAND_TIMEOUT.service
    );
    await runStep('设为开机自启', 'systemctl enable xray && systemctl is-active --quiet xray', REMOTE_COMMAND_TIMEOUT.service);

    // Step 9: 安装切换脚本
    const switchScript = createSwitchScript();
    await runStep('安装切换脚本', `cat > /usr/local/bin/xray-switch << 'SWITCHEOF'\n${switchScript}\nSWITCHEOF && chmod +x /usr/local/bin/xray-switch`);

    return {
      success: true,
      data: {
        uuid: uuidStr,
        privateKey,
        publicKey,
        shortId: shortIdStr,
        vpsIP: vps.host,
        steps,
      },
    };
  } catch (error) {
    return { success: false, error: error.message, steps };
  }
})));

// 客户端配置生成
ipcMain.handle('client:generate-config', wrapHandler(async (event, params) => {
  return generateClientConfig(params);
}));

// 一键优化（BBR + Xray 配置热更新）
ipcMain.handle('ssh:optimize', wrapHandler((event, vpsConfig) => runExclusiveXrayOperation('优化', async () => {
  const steps = [];
  const runStep = async (name, cmd, timeoutMs = REMOTE_COMMAND_TIMEOUT.standard) => {
    const result = await sshManager.exec(cmd, { timeoutMs });
    steps.push({ name, result });
    if (!result.success) {
      throw new Error(`${name}失败: ${result.error || '远端命令未成功执行'}`);
    }
    return result;
  };

  try {
    // Step 1: 启用 BBR 和 TCP Fast Open。
    await runStep('启用 BBR 与 TCP Fast Open', createKernelNetworkTuningCommand());

    // Step 2: 验证 BBR；受限内核可能不暴露个别参数，验证失败不应中断流程，
    // 只在结果中标记 bbrEnabled 供前端提示。
    const bbrResult = await runStep(
      '验证 BBR、队列与 TCP Fast Open',
      'sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc net.ipv4.tcp_fastopen 2>/dev/null || true'
    );
    const bbrOutput = String(bbrResult.data || '');
    const bbrEnabled = /tcp_congestion_control\s*=\s*bbr/.test(bbrOutput);

    // Step 3: 读取当前配置并应用长连接优化字段
    const optimizeScript = generateOptimizeScript();

    await runStep('优化 Xray 配置', optimizeScript);

    // Step 4: 重启 Xray；若服务未正常启动，恢复优化前的当前配置。
    await runStep('重启 Xray 并验证', createOptimizeRestartCommand(), REMOTE_COMMAND_TIMEOUT.service);

    return { success: true, data: { bbr: bbrResult.data, bbrEnabled, steps } };
  } catch (error) {
    return { success: false, error: error.message, steps };
  }
})));

// 系统操作
ipcMain.handle('system:open-url', wrapHandler(async (event, url) => {
  shell.openExternal(url);
}));

// QR Code 生成
ipcMain.handle('qrcode:generate', wrapHandler(async (event, text) => {
  const dataUrl = await QRCode.toDataURL(text, {
    width: 256,
    margin: 2,
    color: {
      dark: '#1e1e2e',
      light: '#ffffff',
    },
  });
  return { success: true, dataUrl };
}));
