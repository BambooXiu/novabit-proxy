// ==================== Client Component ====================

window.App = window.App || {};

(function() {
  let _fullConfig = null;
  let _currentConfig = null;

  function updateClientPage(config) {
    _currentConfig = config;
    const infoBox = document.querySelector('.client-info-box');
    const qrSection = document.getElementById('qrSection');
    const configSection = document.getElementById('configSection');

    if (config.deploy.deployed) {
      infoBox.style.display = 'none';
      qrSection.style.display = 'block';
      configSection.style.display = 'block';
      generateClientConfig(config).catch((error) => {
        App.notify('生成客户端配置失败: ' + getErrorMessage(error), 'error');
      });
    } else {
      infoBox.style.display = 'flex';
      qrSection.style.display = 'none';
      configSection.style.display = 'none';
    }
  }

  async function generateClientConfig(config) {
    if (!config.deploy.deployed) return false;

    try {
      const result = await window.api.client.generateConfig({
        vpsIP: config.deploy.vpsIP,
        uuid: config.deploy.uuid,
        publicKey: config.deploy.publicKey,
        shortId: config.deploy.shortId,
      });

      if (result && result.success === false) {
        throw new Error(result.error || '生成配置失败');
      }
      if (!result || !result.vlessLink || !result.fullConfig || !result.manual) {
        throw new Error('客户端配置数据不完整');
      }

      document.getElementById('vlessLink').value = result.vlessLink;
      setImportHint(result.clientImportNote);
      await generateQRCode(result.vlessLink);

      const tbody = document.getElementById('configTableBody');
      const m = result.manual;
      tbody.innerHTML = `
        <tr><td>地址</td><td>${m.address}</td></tr>
        <tr><td>端口</td><td>${m.port}</td></tr>
        <tr><td>协议</td><td>${m.protocol}</td></tr>
        <tr><td>UUID</td><td>${m.uuid}</td></tr>
        <tr><td>流控</td><td>${m.flow}</td></tr>
        <tr><td>传输方式</td><td>${m.transport}</td></tr>
        <tr><td>安全</td><td>${m.security}</td></tr>
        <tr><td>SNI</td><td>${m.sni}</td></tr>
        <tr><td>PublicKey</td><td>${m.publicKey}</td></tr>
        <tr><td>ShortId</td><td>${m.shortId}</td></tr>
        <tr><td>Fingerprint</td><td>${m.fingerprint}</td></tr>
        <tr><td>MUX</td><td>${m.mux.enabled ? '开启' : (m.mux.note || '关闭')}</td></tr>
        <tr><td>微信直连优化</td><td>仅完整配置导入后生效</td></tr>
        <tr><td>TCP FastOpen</td><td>开启</td></tr>
        <tr><td>KeepAlive</td><td>30s</td></tr>
      `;

      _fullConfig = result.fullConfig;
      return true;
    } catch (error) {
      _fullConfig = null;
      console.error('Generate config error:', error);
      throw error;
    }
  }

  function getErrorMessage(error) {
    return error?.message || error || '未知错误';
  }

  function setImportHint(note) {
    const hint = document.getElementById('clientImportHint');
    if (hint && note) {
      hint.textContent = note;
    }
  }

  async function generateQRCode(text) {
    try {
      const result = await window.api.qrcode.generate(text);
      if (result.success) {
        const canvas = document.getElementById('qrCanvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
        };
        img.src = result.dataUrl;
      }
    } catch (error) {
      console.error('QR code generation failed:', error);
    }
  }

  function copyVLESSLink() {
    const link = document.getElementById('vlessLink').value;
    navigator.clipboard.writeText(link).then(() => {
      App.notify('已复制到剪贴板', 'success');
    }).catch(() => {
      const textarea = document.getElementById('vlessLink');
      textarea.select();
      document.execCommand('copy');
      App.notify('已复制到剪贴板', 'success');
    });
  }

  function copyFullConfig() {
    if (!_fullConfig) {
      App.notify('请先生成客户端配置', 'warning');
      return;
    }
    navigator.clipboard.writeText(_fullConfig).then(() => {
      App.notify('完整配置已复制，可粘贴到 v2rayN/v2rayNG 导入', 'success');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = _fullConfig;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      App.notify('完整配置已复制', 'success');
    });
  }

  async function regenerateConfig() {
    if (!_currentConfig || !_currentConfig.deploy.deployed) {
      App.notify('需要先完成部署才能生成配置', 'warning');
      return;
    }

    try {
      App.notify('正在重新生成配置...', 'info');
      await generateClientConfig(_currentConfig);
      App.notify('配置已重新生成，包含微信直连优化', 'success');
    } catch (error) {
      console.error('Regenerate config error:', error);
      App.notify('生成配置失败: ' + getErrorMessage(error), 'error');
    }
  }

  function init() {
    document.getElementById('btnCopyLink').addEventListener('click', copyVLESSLink);
    document.getElementById('btnCopyFullConfig').addEventListener('click', copyFullConfig);
    document.getElementById('btnRegenerateConfig').addEventListener('click', regenerateConfig);
  }

  window.App.client = { init, updateClientPage };
})();
