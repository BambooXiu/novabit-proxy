// ==================== Main Renderer ====================

// ==================== Global Error Handling ====================
window.onerror = (msg, src, line, col, err) => {
  console.error('Uncaught Error:', { msg, src, line, col, err });
  if (window.App && App.notify) {
    App.notify('发生未知错误，请刷新页面', 'error');
  }
  return true;
};

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled Promise Rejection:', event.reason);
  if (window.App && App.notify) {
    App.notify('操作失败: ' + (event.reason?.message || event.reason || '未知错误'), 'error');
  }
});

// ==================== State ====================
let config = {
  vps: { host: '', port: '22', username: 'root', password: '', privateKey: '' },
  ispProxy: { address: '', port: '', username: '', password: '' },
  deploy: { uuid: '', privateKey: '', publicKey: '', shortId: '', vpsIP: '', deployed: false },
};

// ==================== Init ====================
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  setupNavigation();
  initComponents();
  updateUI();

  if (config.vps.host) {
    App.dashboard.refreshDashboard(config);
  }
});

// ==================== Config ====================
async function loadConfig() {
  const result = await window.api.config.load();
  if (result.success && result.data) {
    config = { ...config, ...result.data };
  }
}

// ==================== Navigation ====================
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      switchPage(page);
    });
  });
}

function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.getElementById(`page-${page}`)?.classList.add('active');
}

// ==================== Components ====================
function initComponents() {
  App.dashboard.init(config);
  App.settings.init(config);
  App.client.init();
  App.deploy.init(config);
  App.guide.init();
}

// ==================== UI Update ====================
function updateUI() {
  App.settings.fillForm(config);
  App.dashboard.updateConnectionStatus();
  App.deploy.updateDeployChecklist(config);
  App.client.updateClientPage(config);
}
