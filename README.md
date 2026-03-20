# eShell

<p align="center">
  <img src="docs/Shell.png" alt="eShell Logo" width="180" />
</p>

eShell 是一个基于 **Tauri 2 + React + Rust** 的桌面化运维工作台，用一个界面整合 SSH、PTY、SFTP、状态监控、脚本执行和 Ops Agent，目标是把“远程连接、诊断分析、命令执行、审批闭环”放到同一条工作流里。

## 功能概览

- 多 SSH 配置管理与多会话并行
- 基于 `xterm.js` 的 PTY 终端
- SFTP 文件浏览、上传、下载、在线编辑
- 服务状态面板：CPU、内存、网卡、磁盘、进程
- 脚本中心：保存并在当前会话执行脚本
- Ops Agent：多轮对话、工具调用、风险命令审批、流式回答
- 终端选区上下文：可把 xterm 里选中的输出附加到 Agent 会话，并持久化到聊天记录

## Ops Agent 能力

### 当前能力

- 多轮会话与会话列表
- `read_shell` / `write_shell` 工具调用
- `write_shell` 审批闭环
- OpenAI-compatible `/chat/completions` 调用
- SSE 流式回答
- 终端选区作为 shell context 附加到用户消息
- shell context 持久化、反序列化、历史回放

### 模块拆分

- `context.rs`：提示词与当前 SSH 会话上下文装配
- `events.rs`：后端向前端发送流式事件
- `openai.rs`：OpenAI-compatible 请求封装、SSE 解码、history 转换
- `service.rs`：对话编排、工具调用与审批流
- `store.rs`：会话、消息、pending action 持久化
- `stream.rs`：SSE `data:` 帧解码
- `tools/`：工具注册、执行和审批处理
- `types.rs`：Ops Agent 数据结构

### 终端上下文工作流

1. 用户在 xterm 中选中一段终端内容。
2. 终端右上角出现 `Add To Agent` 浮动按钮。
3. 点击后，选中内容作为一个 shell context 附件进入 Agent 输入区。
4. 发送消息时，这个 shell context 会和用户问题一起写入当前会话消息。
5. 聊天记录中默认显示一个 shell 图标标记，点击可展开查看完整上下文。
6. 后续每轮调用模型时，历史消息中的 shell context 会一起进入 history。

这意味着 shell context 不再只是“本轮临时提示”，而是正式会话语义的一部分。

### AI 请求链路

前端聊天面板调用的是本地 Tauri 命令：

- `ops_agent_chat_stream_start`

后端再向配置的 OpenAI-compatible 服务发送：

- `POST {baseUrl}/chat/completions`

当前实现分两步：

1. 先走一次非流式 planner 请求，决定是否需要工具调用。
2. 再走一次流式回答请求，输出最终回复或工具总结。

如果提供商不完全兼容 OpenAI `chat/completions`，或者对终端输出内容有额外审核策略，planner 这一步可能直接返回 `400 Bad Request`。

## 技术栈

### 前端

- React 19
- Vite 7
- Tailwind CSS 4
- lucide-react
- react-markdown / remark-gfm / remark-breaks
- `@xterm/xterm` + `@xterm/addon-fit`
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
│  ├─ hooks/
│  │  └─ useWorkbench.js
│  ├─ lib/
│  │  ├─ ops-agent-shell-context.js
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

### 存储说明

- `ops_agent_conversation_list.json` 保存会话摘要、当前 active 会话和 pending actions。
- `ops_agent_conversations/<id>.json` 保存单会话完整消息历史。
- 用户消息现在可以带 `shellContext` 字段，保存终端选区内容、预览文本和来源会话名。
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

### 当前已覆盖验证

- Rust 单元测试：工具注册、SSE 解码、上下文拼装、消息存储、旧数据兼容反序列化
- Vitest：流式事件 reducer、shell context 归一化与附件构造
- Vite 生产构建

## 常见问题

### 1. `runtime error: ops agent AI request failed: status=400 Bad Request`

这通常不是前端按钮或会话存储的问题，而是上游 AI 提供商拒绝了 `/chat/completions` 请求。常见原因：

- 提供商不完全兼容 OpenAI `chat/completions`
- 当前 model 不支持这类请求格式
- system prompt、历史消息或 shell context 中的终端输出触发了内容审核
- `baseUrl`、`model`、`apiKey` 配置不匹配

建议检查：

- 当前 AI 配置的 `baseUrl`
- 当前 profile 选择的 `model`
- 该提供商是否支持流式和非流式 `chat/completions`
- 终端选区里是否包含敏感输出、二进制内容或异常大段日志

### 2. 终端选区没有出现 `Add To Agent`

先确认：

- 当前有激活的 shell session
- 选区不是空白字符
- xterm 选中的内容确实来自终端缓冲区

### 3. 聊天记录里为什么只显示一个 shell 图标

这是设计行为。带 shell context 的用户消息默认折叠显示，只展示一个轻量标记，点击后展开完整终端内容，避免聊天区被长日志淹没。

## 安全说明

- 当前本地配置文件默认未加密，可能包含 SSH 密码和 AI Key。
- `write_shell` 必须进入待审批队列，前端确认后才会执行。
- shell context 可能包含敏感终端输出，发送给模型前请确认内容范围。
- 生产环境建议补充密钥管理、本地加密、审计日志和敏感信息脱敏。

## 相关文档

- [project_description.md](docs/project_description.md)
- [openapi.yaml](docs/openapi.yaml)
