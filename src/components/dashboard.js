// ==================== Dashboard Component ====================

window.App = window.App || {};

(function() {
  const PROXY_MODE_LABEL = 'ISP 代理';
  let connected = false;
  let connecting = false;

  function getConnectionState() {
    return { connected, connecting };
  }

  function setConnectionState(c, ing) {
    connected = c;
    connecting = ing;
  }

  function updateConnectionStatus() {
    const statusEl = document.getElementById('connectionStatus');
    if (!statusEl) return;
    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('span');

    if (connecting) {
      dot.className = 'status-dot connecting';
      text.textContent = '连接中';
    } else if (connected) {
      dot.className = 'status-dot connected';
      text.textContent = '已连接';
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = '未连接';
    }
  }

  function updateProxyModeDescription(config) {
    const modeButton = document.getElementById('btnModeIspProxy');
    if (!modeButton) return;
    const modeName = modeButton.querySelector('.mode-name');
    const modeDesc = modeButton.querySelector('.mode-desc');

    if (modeName) {
      modeName.textContent = PROXY_MODE_LABEL;
    }
    if (modeDesc) {
      const proxyAddress = config?.ispProxy?.address;
      modeDesc.textContent = proxyAddress ? `出口 ${proxyAddress}` : '出口以当前配置为准';
    }
  }

  function isProxyProtocol(proto) {
    return proto === 'socks' || proto === 'http';
  }

  async function verifyExitIP(config, proto) {
    if (isProxyProtocol(proto)) {
      const proxy = config.ispProxy || {};
      if (!proxy.address || !proxy.port) {
        return { success: false, error: '请先配置 ISP 代理' };
      }
      return window.api.xray.verifyIspProxy(proxy);
    }

    return window.api.xray.verifyIp();
  }

  async function refreshDashboard(config) {
    if (!config.vps.host) {
      App.notify('请先配置 VPS 连接信息', 'error');
      return;
    }
    if (connecting) return;

    connecting = true;
    updateConnectionStatus();
    const btnRefresh = document.getElementById('btnRefresh');
    btnRefresh.disabled = true;
    btnRefresh.querySelector('.btn-text').textContent = '刷新中';

    document.getElementById('dashConnectionState').textContent = '连接中...';
    document.getElementById('dashConnectionState').style.color = 'var(--text-muted)';
    document.getElementById('dashCurrentMode').textContent = '--';
    document.getElementById('dashExitIP').textContent = '--';
    updateProxyModeDescription(config);

    try {
      const connResult = await window.api.ssh.connect(config.vps);
      if (!connResult.success) {
        App.notify('连接失败: ' + connResult.error, 'error');
        connected = false;
        connecting = false;
        updateConnectionStatus();
        document.getElementById('dashConnectionState').textContent = '连接失败';
        document.getElementById('dashConnectionState').style.color = 'var(--red)';
        return;
      }

      connected = true;
      connecting = false;
      updateConnectionStatus();

      const xrayStatus = await window.api.xray.status();
      const dashState = document.getElementById('dashConnectionState');
      if (xrayStatus.success && xrayStatus.data.includes('active')) {
        dashState.textContent = '运行中';
        dashState.style.color = 'var(--green)';
      } else {
        dashState.textContent = '未运行';
        dashState.style.color = 'var(--red)';
      }

      const modeResult = await window.api.xray.currentMode();
      const dashMode = document.getElementById('dashCurrentMode');
      let currentProto = 'unknown';
      if (modeResult.success) {
        const proto = modeResult.data;
        currentProto = proto;
        if (isProxyProtocol(proto)) {
          dashMode.textContent = PROXY_MODE_LABEL;
          dashMode.style.color = 'var(--green)';
          document.getElementById('btnModeIspProxy').classList.add('active');
          document.getElementById('btnModeDirect').classList.remove('active');
        } else if (proto === 'freedom') {
          dashMode.textContent = '直连';
          dashMode.style.color = 'var(--yellow)';
          document.getElementById('btnModeDirect').classList.add('active');
          document.getElementById('btnModeIspProxy').classList.remove('active');
        } else {
          dashMode.textContent = '未知';
        }
      }

      const ipResult = await verifyExitIP(config, currentProto);
      document.getElementById('dashExitIP').textContent = ipResult.success ? ipResult.data : '--';

    } catch (error) {
      App.notify('刷新失败: ' + (error.message || error), 'error');
      connecting = false;
      connected = false;
      updateConnectionStatus();
    } finally {
      btnRefresh.disabled = false;
      btnRefresh.querySelector('.btn-text').textContent = '刷新';
    }
  }

  async function switchMode(config, mode) {
    if (!connected) {
      if (!config.vps.host) {
        App.notify('请先配置 VPS 连接信息', 'error');
        return;
      }
      try {
        const connResult = await window.api.ssh.connect(config.vps);
        if (!connResult.success) {
          App.notify('连接 VPS 失败', 'error');
          return;
        }
        connected = true;
        updateConnectionStatus();
      } catch (e) {
        App.notify('连接 VPS 失败: ' + (e.message || e), 'error');
        return;
      }
    }

    try {
      const result = await window.api.xray.switchMode(mode);
      if (result.success) {
        App.notify(`已切换到 ${mode === 'proxy' ? PROXY_MODE_LABEL : '直连'} 模式`, 'success');
        document.getElementById('btnModeIspProxy').classList.toggle('active', mode === 'proxy');
        document.getElementById('btnModeDirect').classList.toggle('active', mode === 'direct');
        updateProxyModeDescription(config);

        const dashMode = document.getElementById('dashCurrentMode');
        dashMode.textContent = mode === 'proxy' ? PROXY_MODE_LABEL : '直连';
        dashMode.style.color = mode === 'proxy' ? 'var(--green)' : 'var(--yellow)';

        setTimeout(async () => {
          const proto = mode === 'proxy' ? 'socks' : 'freedom';
          const ipResult = await verifyExitIP(config, proto);
          document.getElementById('dashExitIP').textContent = ipResult.success ? ipResult.data : '--';
        }, 1500);
      } else {
        App.notify('切换失败: ' + (result.error || result.data), 'error');
      }
    } catch (error) {
      App.notify('切换失败: ' + (error.message || error), 'error');
    }
  }

  async function verifyIP(config) {
    if (!connected) {
      if (!config.vps.host) {
        App.notify('请先配置 VPS 连接信息', 'error');
        return;
      }
      try {
        const connResult = await window.api.ssh.connect(config.vps);
        if (!connResult.success) {
          App.notify('连接 VPS 失败', 'error');
          return;
        }
        connected = true;
        updateConnectionStatus();
      } catch (e) {
        App.notify('连接 VPS 失败: ' + (e.message || e), 'error');
        return;
      }
    }

    const button = document.getElementById('btnVerifyIP');
    const buttonText = button.querySelector('.btn-text');
    button.disabled = true;
    buttonText.textContent = '验证中...';

    try {
      const modeResult = await window.api.xray.currentMode();
      const proto = modeResult.success ? modeResult.data : 'unknown';
      const result = await verifyExitIP(config, proto);
      if (result.success) {
        document.getElementById('dashExitIP').textContent = result.data;
        App.notify('出口 IP: ' + result.data, 'success');
      } else {
        App.notify('验证失败', 'error');
      }
    } catch (error) {
      App.notify('验证失败: ' + (error.message || error), 'error');
    } finally {
      button.disabled = false;
      buttonText.textContent = '验证出口 IP';
    }
  }

  async function checkXrayStatus(config) {
    if (!connected) {
      if (!config.vps.host) {
        App.notify('请先配置 VPS 连接信息', 'error');
        return;
      }
      try {
        const connResult = await window.api.ssh.connect(config.vps);
        if (!connResult.success) {
          App.notify('连接 VPS 失败', 'error');
          return;
        }
        connected = true;
        updateConnectionStatus();
      } catch (e) {
        App.notify('连接 VPS 失败: ' + (e.message || e), 'error');
        return;
      }
    }

    const button = document.getElementById('btnCheckXray');
    const buttonText = button.querySelector('.btn-text');
    button.disabled = true;
    buttonText.textContent = '检查中...';

    try {
      const result = await window.api.xray.status();
      if (result.success) {
        const lines = result.data.split('\n');
        const active = lines[0];
        const enabled = lines[1];

        const dashState = document.getElementById('dashConnectionState');
        if (active === 'active') {
          dashState.textContent = '运行中';
          dashState.style.color = 'var(--green)';
          App.notify(`Xray 运行中 (${enabled === 'enabled' ? '已启用开机自启' : '未启用自启'})`, 'success');
        } else {
          dashState.textContent = '未运行';
          dashState.style.color = 'var(--red)';
          App.notify('Xray 未运行', 'error');
        }
      }
    } catch (error) {
      App.notify('检查失败: ' + (error.message || error), 'error');
    } finally {
      button.disabled = false;
      buttonText.textContent = '检查 Xray 状态';
    }
  }

  async function optimizeXray(config) {
    if (!connected) {
      if (!config.vps.host) {
        App.notify('请先配置 VPS 连接信息', 'error');
        return;
      }
      try {
        const connResult = await window.api.ssh.connect(config.vps);
        if (!connResult.success) {
          App.notify('连接 VPS 失败: ' + (connResult.error || '请检查连接信息'), 'error');
          return;
        }
        connected = true;
        updateConnectionStatus();
      } catch (error) {
        App.notify('连接 VPS 失败: ' + (error.message || error), 'error');
        return;
      }
    }

    const button = document.getElementById('btnOptimizeXray');
    const buttonText = button.querySelector('.btn-text');
    button.disabled = true;
    buttonText.textContent = '修复中...';

    try {
      const result = await window.api.ssh.optimize(config.vps);
      if (!result.success) {
        App.notify('修复失败: ' + (result.error || '远端命令未成功执行'), 'error');
        return;
      }

      // 受限内核（OpenVZ/LXC）不支持修改拥塞控制时，配置优化仍生效，但 BBR 未启用，需明确提示。
      if (result.data && result.data.bbrEnabled === false) {
        App.notify('修复完成：Xray 配置已更新；但 VPS 内核不支持 BBR，拥塞控制未启用', 'success');
      } else {
        App.notify('修复完成：网络参数和 Xray 配置已更新并校验', 'success');
      }
      await refreshDashboard(config);
    } catch (error) {
      App.notify('修复失败: ' + (error.message || error), 'error');
    } finally {
      button.disabled = false;
      buttonText.textContent = '修复并优化配置';
    }
  }

  function init(config) {
    updateProxyModeDescription(config);
    document.getElementById('btnRefresh').addEventListener('click', () => refreshDashboard(config));
    document.getElementById('btnModeIspProxy').addEventListener('click', () => switchMode(config, 'proxy'));
    document.getElementById('btnModeDirect').addEventListener('click', () => switchMode(config, 'direct'));
    document.getElementById('btnVerifyIP').addEventListener('click', () => verifyIP(config));
    document.getElementById('btnCheckXray').addEventListener('click', () => checkXrayStatus(config));
    document.getElementById('btnOptimizeXray').addEventListener('click', () => optimizeXray(config));

    // 监听 SSH 状态变化
    window.api.ssh.onStatusChange((status) => {
      console.log('SSH Status Change:', status);
      const statusEl = document.getElementById('connectionStatus');
      if (!statusEl) return;
      const dot = statusEl.querySelector('.status-dot');
      const text = statusEl.querySelector('span');

      switch (status.status) {
        case 'connected':
          connected = true;
          connecting = false;
          dot.className = 'status-dot connected';
          text.textContent = '已连接';
          break;
        case 'connecting':
        case 'reconnecting':
          connected = false;
          connecting = true;
          dot.className = 'status-dot connecting';
          text.textContent = status.message || '连接中';
          break;
        case 'disconnected':
        case 'error':
        case 'failed':
          connected = false;
          connecting = false;
          dot.className = 'status-dot disconnected';
          text.textContent = status.message || '未连接';
          if (status.status === 'failed') {
            App.notify('SSH 连接失败，请手动刷新', 'error');
          }
          break;
      }
    });
  }

  window.App.dashboard = {
    init,
    refreshDashboard,
    updateConnectionStatus,
    getConnectionState,
    setConnectionState,
  };
})();
