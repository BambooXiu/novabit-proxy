const fs = require('fs');
const path = require('path');
const os = require('os');

const STORAGE_VERSION = 2;

class ConfigManager {
  constructor({ safeStorage } = {}) {
    this.configDir = path.join(os.homedir(), '.vps-proxy-manager');
    this.configFile = path.join(this.configDir, 'config.json');
    this.safeStorage = safeStorage;
    this.config = null;
  }

  ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(this.configDir, 0o700);
  }

  getEncryption() {
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储当前不可用，无法安全读写代理凭据');
    }
    return this.safeStorage;
  }

  normalize(config) {
    const defaults = this.getDefault();
    const source = config && typeof config === 'object' ? config : {};
    const reservedKeys = new Set(['vps', 'ispProxy', 'deploy', 'xray']);
    const legacyProxyEntry = source.ispProxy ? undefined : Object.entries(source).find(([key, value]) => (
        !reservedKeys.has(key) &&
        value &&
        typeof value === 'object' &&
        ['address', 'port', 'username', 'password'].every((field) => field in value)
      ));
    const proxySource = source.ispProxy || legacyProxyEntry?.[1] || {};
    const normalized = {
      ...source,
      vps: { ...defaults.vps, ...(source.vps || {}) },
      ispProxy: { ...defaults.ispProxy, ...proxySource },
      deploy: { ...defaults.deploy, ...(source.deploy || {}) },
    };

    if (legacyProxyEntry) {
      delete normalized[legacyProxyEntry[0]];
    }
    return normalized;
  }

  load() {
    try {
      this.ensureDir();
      if (fs.existsSync(this.configFile)) {
        fs.chmodSync(this.configFile, 0o600);
        const data = fs.readFileSync(this.configFile, 'utf-8');
        const stored = JSON.parse(data);
        if (stored.storageVersion === STORAGE_VERSION) {
          if (typeof stored.encryptedConfig !== 'string' || !stored.encryptedConfig) {
            throw new Error('本地加密配置格式无效');
          }
          const encryption = this.getEncryption();
          const decrypted = encryption.decryptString(Buffer.from(stored.encryptedConfig, 'base64'));
          this.config = this.normalize(JSON.parse(decrypted));
          fs.chmodSync(this.configFile, 0o600);
          return { success: true, data: this.config };
        }

        this.config = this.normalize(stored);
        const migrated = this.save(this.config);
        if (!migrated.success) return migrated;
        return { success: true, data: this.config };
      }
      return { success: true, data: this.getDefault() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  save(config) {
    try {
      this.ensureDir();
      const encryption = this.getEncryption();
      this.config = this.normalize(config);
      const encrypted = encryption.encryptString(JSON.stringify(this.config));
      const stored = {
        storageVersion: STORAGE_VERSION,
        encryptedConfig: Buffer.from(encrypted).toString('base64'),
      };
      fs.writeFileSync(this.configFile, JSON.stringify(stored, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.chmodSync(this.configFile, 0o600);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getDefault() {
    return {
      vps: {
        host: '',
        port: '22',
        username: 'root',
        password: '',
        privateKey: '',
      },
      ispProxy: {
        address: '',
        port: '',
        username: '',
        password: '',
      },
      deploy: {
        uuid: '',
        privateKey: '',
        publicKey: '',
        shortId: '',
        vpsIP: '',
        deployed: false,
      },
    };
  }
}

module.exports = { ConfigManager };
