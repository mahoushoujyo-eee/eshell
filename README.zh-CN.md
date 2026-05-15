# eShell

<p align="center">
  <img src="docs/assets/Shell.png" alt="eShell Logo" width="180" />
</p>

**eShell v1.4.0** 是一个基于 **Tauri 2、React 19、Rust** 的桌面运维工作台。

它把 SSH 会话、PTY 终端、SFTP 文件操作、服务器状态监控、脚本执行，以及 AI 辅助运维的 Ops Agent 集成在一个本地优先的桌面应用里。

[English README](README.md)

## 能做什么

- 管理多个 SSH 配置，并在不同会话之间快速切换。
- 使用基于 `xterm.js` 的交互式 PTY 终端，支持尺寸同步和自定义壁纸。
- 通过 SFTP 浏览、预览、编辑、上传、下载和删除远程文件。
- 查看远程服务器 CPU、内存、网络流量、进程和磁盘状态。
- 保存常用脚本，并在当前会话中执行。
- 使用 Ops Agent 进行 AI 辅助运维：读取上下文、规划命令、请求审批并在审批后自动恢复。
- 配置多个 AI Provider Profile，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 兼容协议。
- 支持英文和简体中文 UI，并持久化语言偏好。

## Ops Agent 重点

Ops Agent 是项目的核心 AI 子系统，代码位于 `src-tauri/src/ops_agent/`。

- runtime 网关会判断本轮请求走 `direct_reply`、`lite` 还是 `pro`。
- `direct_reply` 用于问候、API 测试、普通解释等简单问题，不进入 planner 或 ReAct 流程。
- `lite` 使用轻量 ReAct 循环，适合简单工具辅助任务。
- `pro` 使用 planner、executor、reviewer、validator 和最终回答的多 Agent 流程。
- 有风险的 shell 操作会生成待审批动作，不会静默执行。
- 用户批准或拒绝后，系统可以自动恢复被中断的执行流程。
- 长对话使用非破坏式上下文压缩：
  - 用户可见聊天历史不变
  - 私有摘要保存在 `.eshell-data/ops_agent_context_summaries/`
  - 多次压缩会基于旧摘要和新增原文滚动更新，不从完整可见历史反复全量压缩
- 图片附件单独存储，并在模型请求时重新注入为多模态输入。

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
- ssh2
- reqwest
- serde / serde_json

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
  lib/
    tauri-api.js
    ops-agent-stream.js
    ops-agent-message-rendering.js
    ops-agent-shell-context.js
    sftp-transfer.js
    i18n.js

src-tauri/src/
  commands/        # Tauri 命令入口
  server_ops/      # SSH、PTY、SFTP、状态采集
  ops_agent/       # runtime 网关、Agent、Provider、工具、审批、压缩
  storage/         # SSH / 脚本 / AI profiles / AGENTS.md 上下文持久化
  models.rs
  state.rs

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

- Node.js 18+
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
  scripts.json
  ai_profiles.json
  AGENTS.md
  server_agents/
  ops_agent_conversation_list.json
  ops_agent_conversations/
  ops_agent_context_summaries/
  ops_agent_attachments/
  ops_agent_runs/
  ops_agent_debug.log
```

持久化说明：

- `ai_profiles.json` 保存 AI profiles、当前激活 profile、审批模式和 agent 模式。
- `ops_agent_conversations/` 保存完整的用户可见聊天历史。
- `ops_agent_context_summaries/` 保存模型私有上下文摘要，不会替换聊天记录。
- `ops_agent_attachments/` 保存分离的图片附件；conversation JSON 只保存 `attachmentIds`。
- `AGENTS.md` 和 `server_agents/` 保存用户维护的上下文，会在模型请求时注入。

## 文档入口

- [文档总览](docs/README.md)
- [后端架构](docs/guides/architecture/backend_architecture.md)
- [Ops Agent 指南](docs/guides/features/ops_agent.md)
- [Ops Agent 分层架构](docs/guides/architecture/ops_agent_layered_architecture.md)
- [项目开发指南](docs/guides/PROJECT_DEV_GUIDE.md)
- [项目说明](docs/specs/project_description.md)
- [OpenAPI 风格 RPC 规格](docs/specs/openapi.yaml)
- [服务器状态指南](docs/guides/features/server_status.md)
- [SFTP 传输指南](docs/guides/features/sftp_transfer.md)
- [未发布变更](docs/releases/unreleased.md)
- [1.4.0 发布说明](docs/releases/v1.4.0.md)
