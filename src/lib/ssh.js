const { Client } = require('ssh2');

class SSHManager {
  constructor() {
    this.conn = null;
    this.connected = false;
    this.config = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectDelay = 2000;
    this.commandTimeout = 30000;
    this.onStatusChange = null;
    this.isReconnecting = false;
    this.shouldReconnect = false;
  }

  setStatus(status, message = '') {
    if (this.onStatusChange) {
      this.onStatusChange({ status, message });
    }
  }

  stopReconnect() {
    this.shouldReconnect = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
  }

  endCurrentConnection() {
    if (!this.conn) return;

    const connection = this.conn;
    this.conn = null;
    this.connected = false;
    try {
      connection.end();
    } catch (error) {
      // SSH2 may already have released the underlying socket.
    }
  }

  createConnection(config) {
    this.endCurrentConnection();

    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;
      let wasReady = false;

      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const isCurrentConnection = () => conn === this.conn;
      const connectionError = (message) => message || 'SSH 连接断开';

      this.conn = conn;

      conn.on('ready', () => {
        if (!isCurrentConnection()) return;
        wasReady = true;
        this.connected = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.setStatus('connected', '已连接');
        settle({ success: true });
      });

      conn.on('error', (error) => {
        if (!isCurrentConnection()) return;
        const message = connectionError(error.message);
        this.connected = false;
        this.setStatus('error', message);
        settle({ success: false, error: message });

        if (wasReady && this.shouldReconnect && !this.isReconnecting) {
          this.tryReconnect();
        }
      });

      conn.on('close', () => {
        if (!isCurrentConnection()) return;

        this.conn = null;
        this.connected = false;
        settle({ success: false, error: 'SSH 连接断开' });

        if (wasReady && this.shouldReconnect && !this.isReconnecting) {
          this.setStatus('disconnected', '连接断开');
          this.tryReconnect();
        }
      });

      this.setStatus('connecting', '连接中...');

      const connConfig = {
        host: config.host,
        port: parseInt(config.port, 10) || 22,
        username: config.username,
        readyTimeout: 10000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };

      if (config.privateKey) {
        connConfig.privateKey = config.privateKey;
      } else if (config.password) {
        connConfig.password = config.password;
      }

      try {
        conn.connect(connConfig);
      } catch (error) {
        const message = connectionError(error.message);
        this.connected = false;
        this.setStatus('error', message);
        settle({ success: false, error: message });
      }
    });
  }

  async connect(config) {
    this.stopReconnect();
    this.config = config;
    return this.createConnection(config);
  }

  async tryReconnect() {
    if (!this.config || this.isReconnecting || !this.shouldReconnect) return;

    this.isReconnecting = true;

    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      this.reconnectAttempts = attempt;
      this.setStatus('reconnecting', `重连中 (${attempt}/${this.maxReconnectAttempts})...`);

      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));
      if (!this.shouldReconnect) return;

      const result = await this.createConnection(this.config);
      if (result.success) return;
    }

    if (this.shouldReconnect) {
      this.shouldReconnect = false;
      this.isReconnecting = false;
      this.setStatus('failed', '重连失败，请手动刷新');
    }
  }

  async testConnection(config) {
    try {
      const connResult = await this.connect(config);
      if (!connResult.success) {
        return { success: false, error: connResult.error || 'Connection failed' };
      }

      const result = await this.exec('echo "connected" && uname -a', { timeoutMs: 10000 });
      if (!result.success) {
        return { success: false, error: result.error || 'Connection probe failed' };
      }

      return { success: true, data: result.data };
    } catch (error) {
      return { success: false, error: error.message || error.error || 'Connection failed' };
    } finally {
      this.disconnect();
    }
  }

  async exec(command, { timeoutMs = this.commandTimeout } = {}) {
    return new Promise((resolve) => {
      if (!this.conn || !this.connected) {
        resolve({ success: false, data: '', error: 'Not connected' });
        return;
      }

      let settled = false;
      let timeoutId = null;
      let stdout = '';
      let stderr = '';

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      try {
        this.conn.exec(command, (error, stream) => {
          if (error) {
            finish({ success: false, data: '', error: error.message });
            return;
          }

          stream.on('data', (data) => {
            stdout += data.toString();
          });

          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          stream.on('error', (streamError) => {
            finish({ success: false, data: stdout.trim(), error: streamError.message });
          });

          stream.on('close', (code) => {
            if (code === 0) {
              finish({ success: true, data: stdout.trim() });
            } else {
              finish({ success: false, data: stdout.trim(), error: stderr.trim() || `Command exited with code ${code}` });
            }
          });

          if (timeoutMs > 0) {
            timeoutId = setTimeout(() => {
              try {
                stream.close();
              } catch (closeError) {
                // The channel may have already been closed by the remote host.
              }
              finish({
                success: false,
                data: stdout.trim(),
                error: `Command timed out after ${timeoutMs}ms`,
              });
            }, timeoutMs);
          }
        });
      } catch (error) {
        finish({ success: false, data: '', error: error.message });
      }
    });
  }

  disconnect() {
    this.stopReconnect();
    const hadConnection = Boolean(this.conn);
    this.endCurrentConnection();
    if (hadConnection) {
      this.setStatus('disconnected', '已断开');
    }
  }

  isConnected() {
    return this.connected;
  }
}

module.exports = { SSHManager };
