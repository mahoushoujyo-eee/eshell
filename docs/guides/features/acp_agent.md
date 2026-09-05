# ACP Agent 集成指南

本文记录 eShell 通过 **ACP（Agent Client Protocol）** 集成外部编码 agent 的调研结论与当前实现。ACP Agent 面板现已取代原 AI 助手，停靠在主工作区右侧。

相关文档：

- [ACP 面板前端指南](acp_panel_frontend.md) — **UI 交接文档**：组件结构、状态契约、交互清单与 UI 待优化清单
- [Webshell 会话指南](webshell_session.md) — 终端断连检测与重连（与 ACP 无关，但 UI 风格需统一）
- [Ops Agent 指南](ops_agent.md) — 自研 agent 子系统（后端保留，聊天面板已由 ACP 取代）
- [后端架构](../architecture/backend_architecture.md)

## 1. ACP 是什么

[Agent Client Protocol](https://agentclientprotocol.com/) 是 Zed 主导的开放协议（Apache-2.0），标准化「编辑器/桌面客户端 ↔ 编码 agent」之间的通信，定位类似 LSP 之于语言服务、MCP 之于工具调用。

- **Client**（eShell）负责：UI 渲染、把 agent 作为子进程启动、流式渲染、权限审批、文件/终端回调。
- **Agent**（Codex、Claude Code、Gemini CLI…）负责：思考、规划、调用工具。
- **一次实现，全家通用**：ACP 生态里 Codex、Claude Code、Gemini、Copilot、OpenCode 等都可作为 agent 接入。

与 eShell 现有 Ops Agent 的关系：Ops Agent 是「自己直调 LLM API + 自研 ReAct/多 agent 流程」；ACP 是「把现成 agent CLI 当子进程驱动」。ACP 面板已取代原 AI 助手成为主聊天入口；Ops Agent 后端（`ai_ask`、命令草稿等）保持不变，AI 配置入口移至左侧工具栏「配置」区。

## 2. 协议要点

### 2.1 传输

本地 agent 以子进程运行，通信为 **JSON-RPC 2.0 over stdio，按行分隔 JSON（ndjson）**（不是 LSP 的 Content-Length 帧）。Agent 的 stdout 被 JSON-RPC 独占，agent 自身日志必须写 stderr。

远程 agent（HTTP/SSE）规范仍在演进，本实现只覆盖 stdio。

### 2.2 核心方法

| 方法 | 方向 | 实现 | 说明 |
| --- | --- | --- | --- |
| `initialize` | C→A | ✅ | 协商 `protocolVersion` 与双方能力；eShell 声明 fs 读写能力与 `client_info` |
| `authenticate` | C→A | ✅ | `session/new` 返回 AUTH_REQUIRED 时面板显示登录卡片，按 `authMethods` 选择方式登录（如 ChatGPT OAuth），成功后自动重试建会话 |
| `session/new` | C→A | ✅ | 传 `cwd`、`mcpServers`（均可配置），返回 `sessionId` 与可用模式 |
| `session/load` | C→A | ✅ | 历史面板「恢复会话」触发；agent 回放历史重建消息流，不支持时降级新会话 |
| `session/prompt` | C→A | ✅ | 发送用户消息；响应返回时整个 turn 结束（`stopReason`） |
| `session/update` | A→C | ✅ | 流式通知（见 2.3，全部变体已桥接） |
| `session/cancel` | C→A | ✅ | 中断当前 turn；同时把挂起的权限请求按规范回 `cancelled` |
| `session/set_mode` | C→A | ✅ | 切换会话模式（面板头部下拉框） |
| `session/request_permission` | A→C | ✅ | 转发到面板内联审批卡片，等用户选择后回包 |
| `fs/read_text_file` / `fs/write_text_file` | A→C | ✅ | agent 借用 eShell 文件系统（支持 line/limit 切片、自动建父目录） |
| `terminal/*` | A→C | ❌ | 能力声明为 false，agent 用自己进程执行命令（Codex 即此模型）；操作远程服务器走 eShell MCP 工具（见 4.5） |

### 2.3 `session/update` 变体 → 前端事件

所有变体翻译为 Tauri 事件 `acp-agent-stream` 的 `stage`：

- `agent_message_chunk` → `delta` — 助手正文流（Markdown 渲染）
- `user_message_chunk` → `user` — 仅在 `session/load` 回放时用于重建用户消息
- `agent_thought_chunk` → `thought` — 思考过程流（可折叠展示）
- `tool_call` / `tool_call_update` → 同名 stage — 工具调用卡片（kind/status/locations/diff/输出/原始入参）
- `plan` → `plan` — TODO 计划（面板底部常驻卡片，含完成度）
- `available_commands_update` → `commands` — 斜杠命令（输入 `/` 自动补全）
- `current_mode_update` → `mode` — 模式切换同步到面板下拉框
- `usage_update` → `usage` — 上下文用量（头部百分比徽标）
- 连接结束（正常/异常）→ `stopped` — 面板复位并提示

### 2.4 能力声明

`initialize` 时 client 在 `clientCapabilities` 里声明自己实现的回调。eShell 声明 `fs.readTextFile` / `fs.writeTextFile` 为 true 并在本地实现；`terminal` 声明 false（Codex 在自己进程里执行命令并回传输出）。

## 3. Codex 接入方式

Codex 通过官方适配器 [codex-acp](https://github.com/agentclientprotocol/codex-acp) 接入（前身 `@zed-industries/codex-acp`，基于 Codex App Server）：

```bash
# 前提：已安装 Codex CLI 且登录（ChatGPT 订阅 / OPENAI_API_KEY / CODEX_API_KEY）
npx @agentclientprotocol/codex-acp
```

注意事项：

- 适配器迭代较快，spawn 命令做成**可配置**（eShell 的 `acp_agents.json`），不硬编码。
- Windows 下 spawn `npx` 需走 `.cmd` shim 或 `cmd /c`，直接 spawn `npx` 会失败。
- Codex 的终端模型与其它 agent 不同：它在**自己进程里**执行命令并回传输出，而不是调用 client 的 `terminal/*` 回调。
- agent stderr 用于日志，stdout 只允许 JSON-RPC。

## 4. eShell 实现

### 4.1 后端（Rust，`src-tauri/src/ops_agent/acp/`）

基于官方 [`agent-client-protocol` crate v2](https://docs.rs/agent-client-protocol)（含 `agent-client-protocol-schema` 线格式类型）。SDK 负责 ndjson JSON-RPC 分帧、子进程 spawn（Windows 自动加 `CREATE_NO_WINDOW`）、消息分发与取消投递；本模块只做 Tauri 桥接：

```
acp/
  client.rs    AcpSessionRunner：连接生命周期（start/prompt/cancel/set_mode/stop）、
               权限请求挂起与回包、fs 回调、EventSink 事件桥接、
               session/update → 前端事件翻译（含单测）
  commands.rs  Tauri 命令、acp_agents.json 配置加载（含单测）
```

连接模型：`Client.builder().connect_with(agent, main_fn)` 的 `main_fn` 挂起在请求通道上（handshake → `session/new` → park loop），Tauri 命令通过 channel 提交请求；runner 停止时 drop 通道让连接收尾、子进程退出。要点：

- **prompt/set_mode 经 `connection.spawn` 并发执行**，park loop 不被长 turn 阻塞，`session/cancel` 才能在 turn 进行中送达。
- **权限请求**：handler 立即把 `Responder` 挂到 `pending_permissions` 表并发 `permission_request` 事件；`acp_permission_respond` 命令回填用户选择。取消 turn 或连接结束时，所有挂起请求按规范回 `cancelled`。
- **fs 回调**：`fs/read_text_file`（支持 `line`/`limit` 切片）与 `fs/write_text_file`（自动创建父目录）直接在 handler 内用 tokio fs 完成。
- **连接收尾**：无论正常停止还是子进程崩溃，都会清理 runner、取消挂起权限并发 `stopped` 事件（异常时携带错误信息），前端据此复位。

### 4.2 配置

`.eshell-data/acp_agents.json`（首次调用 `acp_agent_list` 时自动生成默认值）：

```json
{
  "agents": [
    {
      "id": "codex",
      "name": "Codex",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@agentclientprotocol/codex-acp"],
      "env": {},
      "cwd": "d:/work/project",
      "mcpServers": []
    }
  ]
}
```

- `cwd`（可选）：会话工作目录（`session/new` 的 `cwd`），缺省为 eShell 进程当前目录。
- `mcpServers`（可选）：按 ACP 线格式透传给 agent 的 MCP server 列表（http/sse/stdio）。
- Windows 下 npm 的 `.cmd` shim 需经 `cmd /c` 启动（默认配置已处理）；非 Windows 直接 `npx`。

### 4.3 Tauri 命令

| 命令 | 说明 |
| --- | --- |
| `acp_agent_list` | 列出配置的 agent 及运行状态 |
| `acp_agent_start` | spawn + initialize 握手 + 创建会话（传 `resumeSessionId` 时先尝试 `session/load` 恢复），返回 `sessionId` / `modes` / `agentInfo` / `capabilities`（loadSession、promptImage）/ `resumed`；要求登录时返回 `authRequired` + `authMethods`（连接保持存活） |
| `acp_agent_stop` | 结束会话与子进程 |
| `acp_session_prompt` | 发送一条消息，可附带 `images`（base64 + mimeType，按 agent `promptCapabilities.image` 门控）；返回时 turn 结束（`stopReason`） |
| `acp_session_cancel` | 发送 `session/cancel` 并把挂起权限请求回 `cancelled` |
| `acp_permission_respond` | 回应一条权限请求（`optionId`，null 表示取消） |
| `acp_session_set_mode` | 切换会话模式 |
| `acp_agent_authenticate` | 按选定的 `methodId` 执行 agent 登录流（可能等待浏览器 OAuth），成功后创建会话并返回同 start 的结果 |
| `acp_history_save` / `list` / `get` / `delete` | 本地历史会话存储（`.eshell-data/acp_sessions/`，每会话一个 JSON，transcript 原样存储、图片只留 mimeType） |

事件：`acp-agent-stream`（`agentId` / `sessionId` / `stage` + 按 stage 附带 `chunk` / `toolCall` / `plan` / `commands` / `currentModeId` / `usage` / `permission` / `permissionResolution` / `error`）。

### 4.4 前端

- `src/hooks/useAcpAgent.js`：会话状态机（transcript 合并流式分段、按 `toolCallId` 原位更新工具卡片、权限卡片生命周期、计划/命令/用量/模式状态、`stopped` 复位）；每轮结束与会话停止时自动持久化 transcript；恢复会话时由 `session/load` 回放事件重建消息流。
- `src/components/panels/AcpAgentPanel.jsx`：完整聊天面板 — Markdown 消息流、可折叠思考、工具调用卡片（diff/输出/位置/原始入参）、内联权限审批、计划卡片、模式下拉、斜杠命令补全、上下文用量徽标、历史会话（列表/只读查看/恢复/删除）、图片附件（选择/粘贴，按 agent 能力显示）、终端选中内容附加（终端「Add To Agent」浮层 → composer chip → 随消息发送）。
- 挂载位置：`AppAiDock`（右侧可拖宽 dock，标题栏 AI 按钮开关，Esc 关闭），**取代原 AiAssistantPanel**；标题栏繁忙指示与 ACP turn 状态联动。原 AI 配置弹窗入口移至左侧工具栏「配置」区。
- `src/lib/tauri-api.js` 提供全部 `acp*` API 封装；复用现有 Tailwind token 与 i18n。
- 前端组件结构、状态契约与 UI 待优化清单见 [ACP 面板前端指南](acp_panel_frontend.md)。

### 4.5 eShell MCP 工具（`src-tauri/src/mcp_bridge/`）

Tauri 后端启动时在 `127.0.0.1` 随机端口起一个 **MCP streamable-HTTP 服务**（每次运行生成随机 Bearer token，仅本机可访问且需鉴权）。`acp_agent_start` 会把该端点自动注入 agent 的 `mcpServers`（`acp_agents.json` 中该 agent 设 `"eshellTools": false` 可关闭），Codex 等 agent 由此获得操作 eShell 所管服务器的能力：

| 工具 | 说明 |
| --- | --- |
| `list_ssh_profiles` | 列出已配置的 SSH 服务器（不含凭据） |
| `list_shell_sessions` | 列出当前打开的 webshell 会话（id / 服务器 / 工作目录） |
| `execute_command` | 在指定会话的服务器上执行非交互命令（沿用会话 cwd，`cd` 会更新它），返回 stdout/stderr/exitCode |
| `read_remote_file` / `write_remote_file` | 经 SFTP 读写远程文件 |
| `list_remote_dir` | 经 SFTP 列目录 |
| `get_server_status` | 拉取 CPU/内存/磁盘/网络/进程指标 |

设计要点：

- **只操作用户已打开的会话**——agent 不能自行建立新 SSH 连接，权限边界跟随用户的操作范围；凭据完全不经过 agent。
- 命令与文件写入等 MCP 工具调用会触发 agent 侧权限审批（`session/request_permission`），在面板的审批卡片中放行或拒绝。
- 工具输出上限 60k 字符（超出截断），避免撑爆 agent 上下文。
- 协议实现为最小 streamable HTTP 子集：POST 单 JSON 响应（不开 SSE 流），支持 `initialize` / `tools/list` / `tools/call` / `ping`，通知返回 202。

### 4.6 接入更多 ACP agent

在 `.eshell-data/acp_agents.json` 的 `agents` 数组中追加条目即可（Windows 下 npm 包一律经 `cmd /c npx` 启动）。已验证的包名：

```json
{
  "id": "claude",
  "name": "Claude Code",
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@agentclientprotocol/claude-agent-acp"],
  "env": {}
}
```

| Agent | args（替换上面的 args 即可） | 前提 |
| --- | --- | --- |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | Claude Code 已登录或 `ANTHROPIC_API_KEY` |
| Gemini CLI | `npx -y @google/gemini-cli --experimental-acp` | `gemini` 登录 / `GEMINI_API_KEY` |
| Qwen Code | `npx -y @qwen-code/qwen-code --experimental-acp` | qwen 登录（Qwen OAuth 免费额度）/ API key |
| OpenCode | `npx -y opencode-ai acp` | opencode 已配置 provider |

非 npm 的 agent（Goose `goose acp`、Kimi CLI `kimi acp` 等）直接把 `command` 指向对应可执行文件。各 agent 能力不同（loadSession/图片/模式），面板按 `initialize` 声明自动适配。

### 4.7 图片发送排障

面板发送的图片是规范的 ACP `ImageContent`（base64 + mimeType），codex-acp 会转成 `data:` URL 交给 Codex。若模型回复「image content omitted」，几乎都是 **Codex 实际使用的模型不支持图片输入**（Codex 内核会把图片替换为占位符文本，尤其常见于经代理接入的第三方文本模型，或 `~/.codex/config.toml` 自定义 model）。在终端 `codex` 里用 `/model` 切到视觉模型（如 gpt-5.x-codex 系列）即可。面板侧已做防御：超过 1568px 或过大的图片自动缩放重编码，规避尺寸上限占位符。

## 5. 边界与后续

当前明确不做（后续版本候选）：

- `terminal/*` 客户端回调（声明为 false；远程操作已由 eShell MCP 工具覆盖，交互式 PTY 接入再评估）
- `@`-mention / 音频提示词内容（已支持文本 + 图片块）
- Claude Code 接入（`@agentclientprotocol/claude-agent-acp`，协议相同，加一条配置即可）
- 集成测试（依赖真实 codex-acp 进程，以协议层单测 + 手动冒烟为主）

## 6. 参考

- [ACP 官网](https://agentclientprotocol.com/) · [协议 Schema](https://agentclientprotocol.com/protocol/schema)
- [codex-acp 适配器](https://github.com/agentclientprotocol/codex-acp)
- [claude-code-acp 适配器](https://github.com/zed-industries/claude-code-acp)
- [agent-client-protocol Rust SDK](https://docs.rs/agent-client-protocol)（本实现的依赖，v2.0.0）
- [Zed 官方博客：Codex is Live in Zed](https://zed.dev/blog/codex-is-live-in-zed)
