// ==================== Settings Component ====================

window.App = window.App || {};

(function() {
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
    document.getElementById('ispProxyAddress').value = config.ispProxy.address;
    document.getElementById('ispProxyPort').value = config.ispProxy.port;
    document.getElementById('ispProxyUsername').value = config.ispProxy.username;
    document.getElementById('ispProxyPassword').value = config.ispProxy.password;
  }

  function init(config) {
    document.getElementById('vpsAuthType').addEventListener('change', (e) => {
      document.getElementById('vpsPasswordGroup').classList.toggle('hidden', e.target.value !== 'password');
      document.getElementById('vpsKeyGroup').classList.toggle('hidden', e.target.value !== 'key');
    });
    document.getElementById('btnTestSSH').addEventListener('click', testSSH);
    document.getElementById('btnSaveVPS').addEventListener('click', () => saveVPSSettings(config));
    document.getElementById('btnSaveIspProxy').addEventListener('click', () => saveIspProxySettings(config));
  }

  window.App.settings = { init, fillForm, saveConfig };
})();
