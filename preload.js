const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
  },

  // SSH
  ssh: {
    test: (vpsConfig) => ipcRenderer.invoke('ssh:test', vpsConfig),
    connect: (vpsConfig) => ipcRenderer.invoke('ssh:connect', vpsConfig),
    disconnect: () => ipcRenderer.invoke('ssh:disconnect'),
    optimize: (vpsConfig) => ipcRenderer.invoke('ssh:optimize', vpsConfig),
    onStatusChange: (callback) => {
      ipcRenderer.on('ssh:status-change', (event, status) => callback(status));
    },
  },

  // Xray
  xray: {
    status: () => ipcRenderer.invoke('xray:status'),
    currentMode: () => ipcRenderer.invoke('xray:current-mode'),
    switchMode: (mode) => ipcRenderer.invoke('xray:switch-mode', mode),
    verifyIp: () => ipcRenderer.invoke('xray:verify-ip'),
    verifyIspProxy: (config) => ipcRenderer.invoke('xray:verify-isp-proxy', config),
  },

  // 部署
  deploy: {
    run: (config) => ipcRenderer.invoke('deploy:run', config),
  },

  // 客户端配置
  client: {
    generateConfig: (params) => ipcRenderer.invoke('client:generate-config', params),
  },

  // 系统
  system: {
    openUrl: (url) => ipcRenderer.invoke('system:open-url', url),
  },

  // QR Code
  qrcode: {
    generate: (text) => ipcRenderer.invoke('qrcode:generate', text),
  },
});
