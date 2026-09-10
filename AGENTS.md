# AGENTS.md

本文件为 Codex 在处理本仓库代码时提供指导。内容由 `CLAUDE.md` 改写而来，保留项目事实、命令、架构和代码风格要求。

## 项目概述

**NovaBit Proxy** - 跨平台桌面应用（macOS/Windows），用于管理 VPS 代理模式切换。支持一键切换 ISP SOCKS5 代理与直连模式，并可将 Xray-core（VLESS + Reality）部署到远程 VPS 服务器。

## 常用命令

```bash
# 安装依赖
npm install

# 开发模式运行
npm start

# 运行测试（配置生成验证）
npm test

# 构建 macOS DMG 安装包
npm run build:dmg

# 构建 Windows EXE 安装程序
npm run build:win

# 构建 macOS 包（默认目标）
npm run build
```

## 高层架构

这是一个 Electron 应用，采用 IPC 进行进程间通信，职责划分清晰。

### 1. 主进程 (`main.js`)

- Electron 入口点，创建 BrowserWindow。
- 通过 `SSHManager` 管理 SSH 连接生命周期。
- 通过 `ConfigManager` 管理应用配置。
- 处理来自渲染进程的 IPC 调用。
- 核心职责：
  - 远程 VPS 的 SSH 连接管理。
  - Xray 部署与配置。
  - 模式切换（ISP 代理/直连）。
  - 二维码生成。
  - 客户端配置生成。

### 2. 预加载脚本 (`preload.js`)

- 通过 `contextBridge` 向渲染进程暴露安全的 API 桥接。
- 在 `window.api` 命名空间下定义所有 IPC 通道。
- 按领域组织：`config`、`ssh`、`xray`、`deploy`、`client`、`system`、`qrcode`。

### 3. 渲染进程 (`src/renderer.js`)

- 基于标签页导航的单页应用。
- 全局错误处理，捕获未捕获异常和 Promise 拒绝。
- `window.App` 命名空间下的组件化架构。

### 4. 核心库 (`src/lib/`)

| 文件 | 用途 | 主要导出 |
|------|------|----------|
| `ssh.js` | 带自动重连的 SSH2 封装 | `SSHManager` 类，包含 `connect()`、`exec()`、`disconnect()` |
| `config.js` | 加密配置存储与旧配置迁移 | `ConfigManager` 类（通过系统安全存储加密后保存于 `~/.vps-proxy-manager/config.json`） |
| `xray-config.js` | Xray 配置生成 | `createServerConfig()`、`generateClientConfig()`、`generateOptimizeScript()` |

### 5. UI 组件 (`src/components/`)

| 文件 | 用途 |
|------|------|
| `dashboard.js` | 连接状态、模式切换、IP 验证 |
| `settings.js` | VPS 和 ISP 代理配置表单 |
| `deploy.js` | 一键 Xray 部署向导 |
| `client.js` | VLESS 链接生成、二维码、完整配置导出 |
| `guide.js` | FAQ 和使用指南 |
| `notify.js` | Toast 通知系统 |

## 关键配置常量

位于 `src/lib/xray-config.js`：

- `REALITY_SNI = 'www.apple.com'` - Reality 协议握手域名。
- `OPENAI_PROXY_DOMAINS` - OpenAI 域名路由规则。
- `RECOMMENDED_POLICY` - 连接池/超时设置。

## IPC 模式

所有 IPC 处理器都使用 `wrapHandler()` 错误边界包装器，捕获异常并返回 `{ success: boolean, error?: string, data?: any }` 格式。添加新 IPC 处理器时请遵循此模式。

## 测试策略

- 测试文件：`scripts/test-config-generation.js`。
- 使用 `npm test` 运行测试。
- 专注于配置生成的正确性（JSON 结构、Reality SNI、MUX 禁用、策略设置）。
- 无测试运行器依赖，使用 Node.js 内置的 `assert` 模块。

## 构建输出

- 构建产物输出到 `dist/` 目录。
- macOS：同时包含 arm64 + x64 架构的 DMG。
- Windows：NSIS 安装程序（仅 x64）。

## 代码风格说明

- 所有 UI 和日志均为中文（应用主要面向中文用户）。
- SSH 命令使用 heredoc 模式（`cat > file << 'EOF'`）避免 JSON 内容的引号问题。
- 防御式错误处理：所有异步操作返回成功对象，永不抛出异常。
- `SSHManager` 内置重连逻辑（3 次尝试，间隔 2 秒）。
