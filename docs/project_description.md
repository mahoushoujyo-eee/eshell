# eShell 项目说明

## 1. 项目定位

eShell 是一个面向日常运维场景的桌面工作台，目标是在一个应用内完成：

- SSH 连接管理
- PTY 终端交互
- SFTP 文件管理
- 服务状态监控
- 脚本执行
- Ops Agent 辅助诊断与命令规划

整体架构采用 `Tauri 2 + React + Rust`，强调本地部署、低资源占用和模块化扩展。

## 2. 当前目标

1. 提供接近原生 Shell 的交互体验。
2. 支持多会话并行，避免不同会话间状态串扰。
3. 覆盖常见运维文件流转与状态排查需求。
4. 通过 Ops Agent 提供对话式诊断、工具调用和审批闭环。
5. 保证配置与会话数据可持久化、可恢复、可追踪。

## 3. 已实现能力

### 3.1 SSH 与终端

- SSH 配置增删改查
- 多 Shell 会话管理
- PTY 输入、输出和窗口缩放同步
- 基于 `xterm.js` 的终端渲染

### 3.2 SFTP 与文件

- 目录浏览
- 文件上传、下载
- 远程文件读取与保存
- 编辑器弹窗

### 3.3 服务状态

- CPU、内存、网卡、磁盘、进程采集
- 缓存与轮询刷新

### 3.4 脚本中心

- 脚本定义存储
- 在当前会话执行脚本命令

### 3.5 Ops Agent

- OpenAI-compatible 模型接入
- 多轮会话和会话切换
- 工具调用分层：
  - `read_shell`：自动执行只读诊断命令
  - `write_shell`：进入待审批队列，用户确认后执行
- 工具结果回写对话上下文
- 真实 SSE 上游流式回答

## 4. Ops Agent 架构

本次整理后的模块边界如下：

- `store.rs`
  - 会话与 pending action 持久化
  - 兼容旧版单文件迁移
- `context.rs`
  - 统一管理提示词拼装
  - 统一管理会话上下文提取
- `tools/`
  - 工具定义
  - 工具注册
  - 工具执行与审批回调
- `stream.rs`
  - OpenAI-compatible SSE 帧解码
- `events.rs`
  - Tauri 前端流式事件发射
- `openai.rs`
  - Planner 请求
  - 最终答案流式请求
  - 工具结果总结流式请求
- `service.rs`
  - 编排整轮对话执行流程

## 5. 工具注册设计

Ops Agent 不再把工具说明硬编码在提示词里，而是通过运行时注册表提供：

- `OpsAgentToolRegistry`
- `OpsAgentToolDefinition`
- `OpsAgentTool`

当前默认注册：

- `ReadShellTool`
- `WriteShellTool`

如果后续增加工具，只需要：

1. 实现 `OpsAgentTool`。
2. 在注册表中注册。
3. 提供对应的 planner 描述和执行逻辑。

不需要再去手改 service 里的大段 `match` 提示词常量。

## 6. 流式设计

### 6.1 后端

- 对 OpenAI-compatible `chat/completions` 请求开启 `stream: true`
- 使用 `stream.rs` 解析 SSE `data:` 帧
- 增量发射以下前端事件：
  - `started`
  - `delta`
  - `tool_read`
  - `requires_approval`
  - `completed`
  - `error`

### 6.2 前端

- 在 `src/lib/ops-agent-stream.js` 中对流式事件做归一化和 reducer 化
- `useWorkbench` 只负责订阅、触发状态更新和后续刷新
- 使用 `startTransition` 降低流式文本更新对主交互的影响

## 7. 数据持久化

运行目录统一使用 `.eshell-data/`：

- `ssh_configs.json`
- `scripts.json`
- `ai_profiles.json`
- `ops_agent_conversation_list.json`
- `ops_agent_conversations/<conversationId>.json`

补充规则：

- 新会话默认标题：`New Conversation`
- 首条用户消息可自动生成标题
- pending action 增加 `toolKind`，用于审批时回路由到具体工具
- 兼容旧版 `ops_agent.json` / `ai_config.json` 迁移

## 8. 测试策略

### 8.1 Rust

已覆盖：

- 工具注册
- SSE 流解析
- 提示词上下文拼装
- Ops Agent 存储与迁移

### 8.2 Frontend

已覆盖：

- 流式事件归一化
- `started / delta / completed / error / requires_approval` 状态推进
- pending action upsert

## 9. 当前限制

- 当前审批后的 `write_shell` 结果会写回对话，但不会自动再触发一轮新的模型总结。
- 本地配置默认未加密，仍需在生产环境补充密钥管理和审计能力。
- 前端生产构建仍存在大 bundle 提示，后续可以继续做拆包优化。
