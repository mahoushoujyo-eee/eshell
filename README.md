# eShell

<p align="center">
  <img src="docs/Shell.png" alt="eShell Logo" width="180" />
</p>

eShell 是一个基于 **Tauri 2 + React + Rust** 的桌面化运维工作台，用一个界面整合 SSH、PTY、SFTP、状态监控、脚本执行和 Ops Agent。

## 功能概览

- 多 SSH 配置管理与多会话并行
- 基于 `xterm.js` 的 PTY 终端
- SFTP 文件浏览、上传、下载、在线编辑
- 服务状态面板：CPU、内存、网卡、磁盘、进程
- 脚本中心：保存并在当前会话执行脚本
- Ops Agent：多轮对话、工具调用、风险命令审批、流式回答

## Ops Agent 现状

- 会话数据拆分存储：
  - `ops_agent_conversation_list.json`
  - `ops_agent_conversations/<conversationId>.json`
- 工具注册从提示词硬编码改为运行时注册：
  - `read_shell`
  - `write_shell`
- 通用层已拆分：
  - `context.rs`：提示词与会话上下文装配
  - `tools/`：工具定义、注册、执行、审批处理
  - `stream.rs`：OpenAI-compatible SSE 解码
  - `events.rs`：前端流式事件发射
  - `service.rs`：对话编排
- 流式能力已改为真实 SSE 上游流：
  - Rust 后端对 OpenAI-compatible `/chat/completions` 使用 `stream: true`
  - 增量解析 SSE `data:` 帧
  - 前端通过 reducer 处理 `started / delta / tool_read / requires_approval / completed / error`

## 技术栈

### 前端

- React 19
- Vite 7
- Tailwind CSS 4
- lucide-react
- react-markdown / remark-gfm / remark-breaks
- @xterm/xterm + @xterm/addon-fit
- Vitest

### 后端

- Tauri 2
- Rust
- ssh2
- reqwest
- serde / serde_json

## 目录结构

```text
.
├─ src/
│  ├─ components/
│  │  ├─ layout/
│  │  ├─ panels/
│  │  └─ sidebar/
│  ├─ hooks/useWorkbench.js
│  ├─ lib/
│  │  ├─ ops-agent-stream.js
│  │  └─ tauri-api.js
│  └─ utils/
├─ src-tauri/
│  └─ src/
│     ├─ commands.rs
│     ├─ ssh_service.rs
│     ├─ storage.rs
│     ├─ state.rs
│     └─ ops_agent/
│        ├─ context.rs
│        ├─ events.rs
│        ├─ openai.rs
│        ├─ service.rs
│        ├─ store.rs
│        ├─ stream.rs
│        ├─ tools/
│        └─ types.rs
└─ docs/
```

## 快速开始

### 1. 环境要求

- Node.js >= 18
- Rust stable
- Tauri 2 构建依赖

参考：<https://tauri.app/start/prerequisites/>

### 2. 安装依赖

```bash
npm install
```

### 3. 前端开发

```bash
npm run dev
```

### 4. 桌面开发

```bash
npm run tauri dev
```

### 5. 生产构建

```bash
npm run build
npm run tauri build
```

## 数据存储

运行时会在项目根目录生成 `.eshell-data/`：

```text
.eshell-data/
├─ ssh_configs.json
├─ scripts.json
├─ ai_profiles.json
├─ ops_agent_conversation_list.json
└─ ops_agent_conversations/
   ├─ <conversationId>.json
   └─ ...
```

说明：

- `ops_agent_conversation_list.json` 保存会话摘要、active 会话和 pending actions。
- `ops_agent_conversations/<id>.json` 保存单会话完整消息。
- `pendingAction.toolKind` 用于在审批阶段路由回对应工具实现。
- 旧版 `ops_agent.json` / `ai_config.json` 会在启动时迁移并清理。

## 测试与检查

```bash
# 前端单元测试
npm test

# 前端构建检查
npm run build

# 后端单元测试
cd src-tauri
cargo test
```

## 已验证内容

- Rust 单元测试通过：工具注册、SSE 解码、上下文拼装、存储迁移
- Vitest 单元测试通过：前端流式事件归一化与状态推进
- Vite 生产构建通过

## 安全说明

- 当前本地配置文件默认未加密，包含 SSH 密码和 AI Key。
- `write_shell` 必须进入待审批队列，前端确认后才会执行。
- 生产环境建议补充密钥管理、本地加密和审计日志。
