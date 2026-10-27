// ==================== Settings Component ====================

window.App = window.App || {};

(function() {
  let keyOperationBusy = false;

  function updateKeyStatus(message) {
    const status = document.getElementById('sshKeyStatus');
    const key = document.getElementById('vpsPrivateKey').value.trim();
    const usesKey = document.getElementById('vpsAuthType').value === 'key' && Boolean(key);
    const inlineKey = key.includes('-----BEGIN ');
    if (status) status.textContent = message || (usesKey ? (inlineKey ? '已选择私钥内容，请改用本机私钥文件路径。' : '已选择密钥文件：' + key + '。修改连接信息后请重新测试。') : '尚未配置密钥，可使用密码首次连接。');
    const reveal = document.getElementById('btnRevealSSHKey');
    const disable = document.getElementById('btnDisableSSHPassword');
    if (reveal) reveal.disabled = keyOperationBusy || !usesKey || inlineKey;
    if (disable) disable.disabled = keyOperationBusy || !usesKey;
  }

  function setKeyBusy(busy) {
    keyOperationBusy = busy;
    ['vpsHost', 'vpsPort', 'vpsUsername', 'vpsAuthType', 'vpsPassword', 'vpsPrivateKey', 'btnTestSSH', 'btnSaveVPS', 'btnSetupSSHKey'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.disabled = busy;
    });
    updateKeyStatus();
  }

  async function setupKey(config) {
    if (keyOperationBusy) return;
    const vps = getVPSFormValues();
    if (!vps.host || (!vps.password && !vps.privateKey)) {
      App.notify('请先填写主机地址以及密码或已有私钥路径', 'error');
      return;
    }
    setKeyBusy(true);
    updateKeyStatus('正在生成、安装并验证密钥，请勿退出应用…');
    let message;
    try {
      const result = await window.api.ssh.setupKey(vps);
      if (!result.success) throw new Error(result.error);
      config.vps = result.data.vps;
      fillForm(config);
      App.deploy.updateDeployChecklist(config);
      message = '密钥登录已独立验证并保存：' + config.vps.privateKey + '。服务器密码登录策略未更改，请先备份私钥。';
      App.notify('密钥登录已启用并保存', 'success');
    } catch (error) {
      message = '启用失败：' + error.message;
      App.notify(message, 'error');
    } finally {
      setKeyBusy(false);
      updateKeyStatus(message);
    }
  }

  async function disablePassword() {
    if (keyOperationBusy) return;
    const vps = getVPSFormValues();
    setKeyBusy(true);
    updateKeyStatus('等待确认并重新验证密钥登录…');
    let message;
    try {
      const result = await window.api.ssh.disablePassword(vps);
      if (result.cancelled) return;
      if (!result.success) throw new Error(result.error);
      message = result.data.alreadyDisabled ? '已验证密钥登录；服务器已经禁用密码认证。' : '密钥登录已重新验证，服务器默认密码认证已关闭。恢复脚本：' + result.data.rollbackPath;
      App.notify(message, 'success');
    } catch (error) {
      message = '关闭密码登录失败：' + error.message;
      App.notify(message, 'error');
    } finally {
      setKeyBusy(false);
      updateKeyStatus(message);
    }
  }

  async function revealKey() {
    try {
      const result = await window.api.ssh.revealKey(getVPSFormValues().privateKey);
      if (!result.success) App.notify(result.error, 'error');
    } catch (error) { App.notify(error.message, 'error'); }
  }

  function updateAuthFields() {
    const usesKey = document.getElementById('vpsAuthType').value === 'key';
    document.getElementById('vpsPasswordGroup').classList.toggle('hidden', usesKey);
    document.getElementById('vpsKeyGroup').classList.toggle('hidden', !usesKey);
    updateKeyStatus();
  }

  function getVPSFormValues() {
    const authType = document.getElementById('vpsAuthType').value;
    return {
      host: document.getElementById('vpsHost').value.trim(),
      port: document.getElementById('vpsPort').value.trim() || '22',
      username: document.getElementById('vpsUsername').value.trim() || 'root',
      password: authType === 'password' ? document.getElementById('vpsPassword').value : '',
      privateKey: authType === 'key' ? document.getElementById('vpsPrivateKey').value.trim() : '',
    };
  }

  async function testSSH() {
    const vpsConfig = getVPSFormValues();

    if (!vpsConfig.host) {
      App.notify('请输入 VPS 主机地址', 'error');
      return;
    }

    const btn = document.getElementById('btnTestSSH');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 测试中...';

    try {
      const result = await window.api.ssh.test(vpsConfig);
      if (result.success) {
        App.notify('连接测试成功', 'success');
      } else {
        App.notify('连接失败: ' + result.error, 'error');
      }
    } catch (error) {
      App.notify('连接失败: ' + (error.message || error.error || error), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  }

  async function saveConfig(config) {
    const result = await window.api.config.save(config);
    if (result.success) {
      App.notify('配置已保存', 'success');
    } else {
      App.notify('保存失败: ' + result.error, 'error');
    }
  }

  async function saveVPSSettings(config) {
    config.vps = getVPSFormValues();
    await saveConfig(config);
    App.deploy.updateDeployChecklist(config);
  }

  async function saveIspProxySettings(config) {
    config.ispProxy = {
      address: document.getElementById('ispProxyAddress').value.trim(),
      port: document.getElementById('ispProxyPort').value.trim(),
      username: document.getElementById('ispProxyUsername').value.trim(),
      password: document.getElementById('ispProxyPassword').value,
    };
    await saveConfig(config);
    App.deploy.updateDeployChecklist(config);
  }

  function fillForm(config) {
    document.getElementById('vpsHost').value = config.vps.host;
    document.getElementById('vpsPort').value = config.vps.port;
    document.getElementById('vpsUsername').value = config.vps.username;
    document.getElementById('vpsPassword').value = config.vps.password;
    document.getElementById('vpsPrivateKey').value = config.vps.privateKey;
    document.getElementById('vpsAuthType').value = config.vps.privateKey ? 'key' : 'password';
    updateAuthFields();
    document.getElementById('ispProxyAddress').value = config.ispProxy.address;
    document.getElementById('ispProxyPort').value = config.ispProxy.port;
    document.getElementById('ispProxyUsername').value = config.ispProxy.username;
    document.getElementById('ispProxyPassword').value = config.ispProxy.password;
  }

  function init(config) {
    document.getElementById('vpsAuthType').addEventListener('change', updateAuthFields);
    document.getElementById('btnTestSSH').addEventListener('click', testSSH);
    document.getElementById('btnSaveVPS').addEventListener('click', () => saveVPSSettings(config));
    document.getElementById('btnSaveIspProxy').addEventListener('click', () => saveIspProxySettings(config));
    document.getElementById('btnSetupSSHKey')?.addEventListener('click', () => setupKey(config));
    document.getElementById('btnRevealSSHKey')?.addEventListener('click', revealKey);
    document.getElementById('btnDisableSSHPassword')?.addEventListener('click', disablePassword);
    ['vpsHost', 'vpsPort', 'vpsUsername', 'vpsPrivateKey'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => updateKeyStatus());
    });
  }

  window.App.settings = { init, fillForm, saveConfig };
})();
