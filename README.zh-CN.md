# eShell

<p align="center">
  <img src="docs/assets/Shell.png" alt="eShell Logo" width="180" />
</p>

**eShell v1.6.0** 是一个基于 **Tauri 2、React 19、Rust** 的桌面运维工作台。

它把 SSH 会话、PTY 终端、SFTP 文件操作、服务器状态监控、脚本执行，以及 ACP 编码 agent 面板集成在一个本地优先的桌面应用里。

[English README](README.md)

## 能做什么

- 管理多个 SSH 配置，并在不同会话之间快速切换。
- 使用基于 `xterm.js` 的交互式 PTY 终端，支持尺寸同步、自定义壁纸和 Ctrl+Shift+C/V 复制粘贴。
- 终端断连后原地恢复：重连按钮在同一个 session 上重建 PTY，标签页、工作目录和状态缓存都保留。
- 通过 SFTP 浏览、预览、编辑、上传、下载和删除远程文件。
- 查看远程服务器 CPU、内存、网络流量、进程、磁盘和 NVIDIA 显卡状态。
- 保存常用脚本，并在当前会话中执行。
- 通过 Agent Client Protocol 驱动外部编码 agent（Codex、Claude Code、Gemini CLI 等），支持按项目隔离会话和权限审批。
- 配置多个 AI Provider Profile，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 兼容协议。
- 在 **设置 → 插件** 里安装、启用和移除扩展；外部插件是本地 ESM 目录，安装后无需重启即可生效。
- 支持英文和简体中文 UI，并持久化语言偏好。

## ACP Agent 面板

主 AI 入口是 ACP 面板，它把外部编码 agent 作为子进程，通过 stdio 上的 JSON-RPC 驱动。

- agent 在 `.eshell-data/acp_agents.json` 中声明，面板列出并按需启动。
- 会话按**项目**（记录在 `.eshell-data/projects.json` 的本地目录）分组，切换项目不会重启 agent 进程。
- 会话记录持久化在 `.eshell-data/acp_sessions/`，可恢复。
- agent 的权限请求以审批卡片呈现；`session/cancel` 同时会取消挂起的请求。
- 面板暴露 MCP bridge，agent 可以调用 eShell 自身的工具。

自研的 Ops Agent 运行时（`src-tauri/src/ops_agent/`）仍保留在后端，但其聊天面板已由 ACP 面板取代。运行时本身见 [Ops Agent 指南](docs/guides/features/ops_agent.md)。

## 技术栈

前端：

- React 19
- Vite 7
- Tailwind CSS 4
- xterm.js
- Vitest

后端：

- Tauri 2
- Rust
- russh / russh-sftp（异步 SSH，每个标签页复用一条连接）
- reqwest
- serde / serde_json

## 插件

SFTP 和状态监控仍是默认启用的内置插件，原有界面与命令契约保持兼容，
并与外部浏览器 ESM 插件共用 API-v1 门面。

在 **设置 → 插件 → 从文件夹安装…** 里选中插件目录即可：它会被复制到
`<存储根>/extensions/<清单 id>/` 并立即生效。同一个页面可以启用/禁用每个扩展，
以及移除外部插件；内置扩展只能禁用，它们的代码随应用发布。

仓库自带两个可直接加载的示例：[`examples/hello-plugin/`](examples/hello-plugin/)
（最小示例）和 [`examples/docker-plugin/`](examples/docker-plugin/)（含 controller、
异步会话命令、插件自带图标，以及带单元测试的纯逻辑模块）。也可以手动安装：关闭
eShell，把整个目录复制到 `<存储根>/extensions/<id>/`，然后重启。常规桌面开发运行的
存储根通常为 `src-tauri/.eshell-data`。

安装、移除、启停都是热生效的，**但修改插件代码不是**——改源码仍需重启桌面进程，
没有文件热重载。

**只安装可信代码。** 插件与应用共用 JS 上下文和 Tauri 能力，API 门面不是沙箱，
也不是插件级权限系统。本阶段没有插件市场、插件自动更新或 Node 宿主。
原生实现的更新仍随 eShell 发布。

详见 [插件开发指南](docs/guides/features/plugin_development.md) 和
[插件架构](docs/guides/architecture/builtin_extensions.md)。

## 项目结构

```text
src/
  components/
    ai/            # Provider 图标和 AI 通用 UI
    app/           # 应用外壳、AI Dock、弹窗组合
    layout/        # 标题栏、工具栏、通知
    panels/        # 终端、SFTP、状态、AI 助手、文件编辑器
    sidebar/       # SSH / 脚本 / AI / 壁纸设置
  hooks/
    useWorkbench.js
    workbench/     # 会话、操作、effects、错误、AI profiles
  plugins/         # 内置 SFTP/状态插件控制器与工作台贡献
  lib/
    tauri-api.js
    ops-agent-stream.js
    ops-agent-message-rendering.js
    ops-agent-shell-context.js
    sftp-transfer.js
    i18n.js

src-tauri/src/
  commands/        # Tauri 命令入口
  server_ops/      # SSH、PTY、共享命令传输
  plugins/         # 原生内置插件注册表、SFTP、状态监控、
                   #   外部插件发现/安装、plugin:// 协议
  ops_agent/       # ACP 客户端、自研 agent 运行时、Provider、工具、审批
  storage/         # SSH / 脚本 / AI profiles / agent 上下文持久化
  models/          # 按领域拆分的模型模块
  state.rs

examples/          # 可直接加载的外部插件示例（hello、docker）
skills/            # 面向 agent 的参考文档，首启 seed 到 .eshell-data/agent/skills/

docs/
  guides/
  specs/
  releases/
  reports/
  prompts/
  refer_proj/
```

## 本地开发

前置要求：

- Node.js 22.12+（也可使用 Node 24）
- Rust stable
- 当前操作系统对应的 Tauri 2 依赖

安装依赖：

```bash
npm install
```

只启动前端：

```bash
npm run dev
```

启动桌面应用：

```bash
npm run tauri dev
```

构建：

```bash
npm run build
npm run tauri build
```

## 测试与校验

前端测试：

```bash
npm test
```

Rust 编译检查：

```bash
cd src-tauri
cargo check
```

Rust 测试构建：

```bash
cd src-tauri
cargo test --no-run
```

完整 Rust 测试：

```bash
cd src-tauri
cargo test
```

说明：部分 Windows 环境可能出现测试二进制能编译但无法启动的运行时 DLL 入口问题。遇到这种情况时，可以先以 `cargo check` 和 `cargo test --no-run` 作为基础校验。

## 运行时数据

运行时数据保存在 Tauri 进程工作目录下的 `.eshell-data/`。本地开发时通常是 `src-tauri/.eshell-data/`。

常见内容：

```text
.eshell-data/
  ssh_configs.json
  known_hosts.json
  scripts.json
  ai_profiles.json
  acp_agents.json
  acp_sessions/
  projects.json
  agent/
    AGENTS.md
    <serverId>.md
    skills/
  ops_agent_conversation_list.json
  ops_agent_conversations/
  ops_agent_attachments/
  ops_agent_runs/
  ops_agent_debug.log
  server_ops_debug.log
```

持久化说明：

- `ai_profiles.json` 保存 AI profiles、当前激活 profile、审批模式和 agent 模式。
- `acp_agents.json` 声明面板可启动的 ACP agent；`acp_sessions/` 每个会话一个记录文件。
- `projects.json` 保存 ACP 项目到本地目录的映射。
- `agent/AGENTS.md` 是全局 agent 上下文文件，`agent/<serverId>.md` 是按服务器拆分的上下文，`agent/skills/` 存放 `eshell-config` 和 `eshell-plugin-dev` 两个内置 skill。
- `ops_agent_conversations/` 保存自研 Ops Agent 的聊天历史；`ops_agent_attachments/` 保存分离的图片附件（conversation JSON 只保存 `attachmentIds`）。
- `server_ops_debug.log` 记录服务端操作事件（`pty.worker.started`、`status.probe.failed` 等），会话异常时先看这里。

## 文档入口

- [文档总览](docs/README.md)
- [后端架构](docs/guides/architecture/backend_architecture.md)
- [SSH 传输层](docs/guides/architecture/ssh_transport.md)
- [Webshell 会话](docs/guides/features/webshell_session.md)
- [ACP Agent 指南](docs/guides/features/acp_agent.md)
- [ACP 面板前端](docs/guides/features/acp_panel_frontend.md)
- [Ops Agent 指南](docs/guides/features/ops_agent.md)
- [Ops Agent 分层架构](docs/guides/architecture/ops_agent_layered_architecture.md)
- [项目开发指南](docs/guides/PROJECT_DEV_GUIDE.md)
- [项目说明](docs/specs/project_description.md)
- [OpenAPI 风格 RPC 规格](docs/specs/openapi.yaml)
- [服务器状态指南](docs/guides/features/server_status.md)
- [SFTP 传输指南](docs/guides/features/sftp_transfer.md)
- [插件开发指南](docs/guides/features/plugin_development.md)
- [未发布变更](docs/releases/unreleased.md)
- [1.6.0 发布说明](docs/releases/v1.6.0.md)
