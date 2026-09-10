// ==================== Deploy Component ====================

window.App = window.App || {};

(function() {
  function updateDeployChecklist(config) {
    const vpsOk = config.vps.host && config.vps.username;
    const ispProxyOk = config.ispProxy.address && config.ispProxy.port && config.ispProxy.username;

    const checkVPS = document.getElementById('checkVPS');
    const checkIspProxy = document.getElementById('checkIspProxy');
    const btnDeploy = document.getElementById('btnDeploy');

    checkVPS.className = `check-item ${vpsOk ? 'checked' : 'unchecked'}`;
    checkVPS.querySelector('.check-icon').textContent = vpsOk ? '●' : '○';

    checkIspProxy.className = `check-item ${ispProxyOk ? 'checked' : 'unchecked'}`;
    checkIspProxy.querySelector('.check-icon').textContent = ispProxyOk ? '●' : '○';

    btnDeploy.disabled = !(vpsOk && ispProxyOk);
  }

  async function runDeploy(config) {
    const btnDeploy = document.getElementById('btnDeploy');
    const deployLog = document.getElementById('deployLog');
    const logContent = document.getElementById('logContent');

    btnDeploy.disabled = true;
    btnDeploy.innerHTML = '<span class="loading"></span> 部署中...';
    deployLog.style.display = 'block';
    logContent.innerHTML = '';

    function addLog(msg, type = 'info') {
      const entry = document.createElement('div');
      entry.className = `log-entry ${type}`;
      entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logContent.appendChild(entry);
      logContent.scrollTop = logContent.scrollHeight;
    }

    addLog('开始部署...');

    try {
      addLog('连接 VPS...');
      const connResult = await window.api.ssh.connect(config.vps);
      if (!connResult.success) {
        addLog('连接失败: ' + connResult.error, 'error');
        return;
      }
      App.dashboard.setConnectionState(true, false);
      App.dashboard.updateConnectionStatus();
      addLog('VPS 连接成功', 'success');

      addLog('执行部署脚本...');
      const result = await window.api.deploy.run({
        vps: config.vps,
        ispProxy: config.ispProxy,
      });

      if (result.success) {
        addLog('部署完成!', 'success');

        config.deploy = {
          uuid: result.data.uuid,
          privateKey: result.data.privateKey,
          publicKey: result.data.publicKey,
          shortId: result.data.shortId,
          vpsIP: result.data.vpsIP,
          deployed: true,
        };
        await App.settings.saveConfig(config);

        addLog(`UUID: ${result.data.uuid}`, 'info');
        addLog(`PublicKey: ${result.data.publicKey}`, 'info');
        addLog(`ShortId: ${result.data.shortId}`, 'info');

        if (result.data.steps) {
          result.data.steps.forEach(step => {
            addLog(`[${step.name}] ${step.result.success ? '✓' : '✗'}`, step.result.success ? 'success' : 'error');
          });
        }

        App.notify('部署成功!', 'success');
        App.client.updateClientPage(config);
      } else {
        addLog('部署失败: ' + result.error, 'error');
        if (result.steps) {
          result.steps.forEach(step => {
            addLog(`[${step.name}] ${step.result.success ? '✓' : '✗'}`, step.result.success ? 'success' : 'error');
          });
        }
        App.notify('部署失败', 'error');
      }
    } catch (error) {
      addLog('部署异常: ' + (error.message || error), 'error');
      App.notify('部署异常', 'error');
    } finally {
      btnDeploy.disabled = false;
      btnDeploy.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        开始部署
      `;
    }
  }

  function init(config) {
    document.getElementById('btnDeploy').addEventListener('click', () => runDeploy(config));
  }

  window.App.deploy = { init, updateDeployChecklist };
})();
