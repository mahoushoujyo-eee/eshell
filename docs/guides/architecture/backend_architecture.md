# 后端架构

本文档详细描述 eShell Rust 后端（`src-tauri/src/`）的实现原理。

## 目录

- [整体架构与启动流程](#整体架构与启动流程)
- [内置功能插件](#内置功能插件)
- [错误处理体系](#错误处理体系)
- [核心数据模型](#核心数据模型)
- [状态管理：AppState](#状态管理appstate)
- [存储层](#存储层)
- [服务器操作层（server_ops）](#服务器操作层server_ops)
  - [SSH 连接](#ssh-连接)
  - [命令执行](#命令执行)
  - [PTY 交互式终端](#pty-交互式终端)
  - [SFTP 文件操作](#sftp-文件操作)
  - [服务器状态采集](#服务器状态采集)
- [AI 服务（旧版）](#ai-服务旧版)
- [Ops Agent 架构总览](#ops-agent-架构总览)
- [Ops Agent 领域模型](#ops-agent-领域模型)
- [Ops Agent 工具系统](#ops-agent-工具系统)
  - [ShellTool 安全策略](#shelltool-安全策略)
- [Ops Agent ReAct 循环](#ops-agent-react-循环)
- [流式传输与事件系统](#流式传输与事件系统)
- [审批机制](#审批机制)
- [会话压缩](#会话压缩)
- [多 Provider 适配层](#多-provider-适配层)
- [Tauri 命令层](#tauri-命令层)
- [数据流全景图](#数据流全景图)

---

## 整体架构与启动流程

后端入口是 [`lib.rs`](src-tauri/src/lib.rs)。启动时只干四件事：

1. **解析存储根目录**：`resolve_storage_root()` 返回当前工作目录下的 `.eshell-data/`
2. **初始化 AppState**：创建 `Storage`、`OpsAgentStore`、`OpsAgentAttachmentStore`、工具注册表、运行注册表等
3. **注册所有 Tauri 命令**：通过 `tauri::generate_handler!` 暴露 40+ 个前端可调用的命令
4. **启动 Tauri 事件循环**

```rust
pub fn run() {
    let storage_root = resolve_storage_root();
    let app_state = AppState::new(storage_root).expect("failed to initialize app state");
    let shared_state = Arc::new(app_state);

    tauri::Builder::default()
        .manage(shared_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![...])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**核心设计**：`AppState` 是共享应用上下文，通过 `Arc<AppState>` 提供连接、会话等基础能力；SFTP 和状态监控的专属状态归内置插件注册表及各插件模块管理，不再直接散落在核心状态机中。

## 内置功能插件

`extensions/builtin.json` 是前后端共用清单，默认启用 `eshell.sftp` 和 `eshell.server-monitor`。Rust 实现在 `src-tauri/src/plugins/`，前端控制器与贡献在 `src/plugins/`。SFTP 文件操作、传输取消状态、监控探针和缓存均归所属插件；SSH 连接、PTY 与通用命令传输保留在核心。

现有 SFTP/status Tauri 命令和成功数据格式保持兼容，MCP bridge 通过插件注册表聚合对应工具。`list_extensions` / `set_extension_enabled` 和 `extensions-changed` 用于生命周期管理，选择持久化到存储根的 `extensions/state.json`；存在在途 API 操作时拒绝停用，持久化失败不发布半完成状态，停用不关闭用户会话。

外部插件从 `<存储根>/extensions/*/manifest.json` 发现并合入清单。`list_external_plugins` 返回入口 URL，自定义 `plugin://` 协议只提供已发现目录内通过规范化与后缀校验的资源。前端在首次 React 渲染前调用 `activate(eshell)`；`invoke_extension_api` 是门面背后的白名单原生调用通道，同时持有调用方与功能提供者的生命周期 lease。前端自身的 Tauri 能力并未被隔离：此路由是契约和 busy 管理，不是权限鉴权。详细用法见 [插件开发指南](../features/plugin_development.md)。

当前原生插件仍静态编译并随应用发布，不支持独立热更新，也不构成进程沙箱。完整边界与回归要求见 [内置插件架构](builtin_extensions.md)。

---

## 错误处理体系

[`error.rs`](src-tauri/src/error.rs) 定义了统一的错误枚举：

```rust
pub enum AppError {
    Io(std::io::Error),
    SerdeJson(serde_json::Error),
    SshTransport(russh::Error),
    Sftp(russh_sftp::client::error::Error),
    Reqwest(reqwest::Error),
    Base64(base64::DecodeError),
    NotFound(String),
    Validation(String),
    Runtime(String),
}
```

- `thiserror` 自动生成 `Display` 和 `From` 转换
- `AppResult<T>` 是 `Result<T, AppError>` 的别名
- `to_command_error()` 把 `AppError` 转为字符串，因为 Tauri 命令的错误类型是 `String`

**设计意图**：内部服务全部返回 `AppResult`，只在命令层做一次字符串转换，保持核心代码的类型安全。

---

## 核心数据模型

[`models/`](src-tauri/src/models) 按领域拆分定义了前后端共享的全部 DTO（`ssh.rs`、`shell.rs`、`sftp.rs`、`status.rs`、`script.rs`、`ai.rs`、`ai_import.rs`、`common.rs`）：

| 结构 | 用途 |
|------|------|
| `SshConfig` / `SshConfigInput` | SSH 连接配置 |
| `ShellSession` | 运行时会话（ID、配置ID、当前目录、最后输出） |
| `CommandExecutionResult` | 命令执行结果（stdout/stderr/exit_code/duration） |
| `SftpEntry` / `SftpListResponse` | SFTP 文件条目 |
| `SftpTransferEvent` | 传输进度事件 |
| `ServerStatus` | 服务器状态（CPU/内存/网卡/进程/磁盘） |
| `ScriptDefinition` / `ScriptInput` | 脚本定义 |
| `AiConfig` / `AiProfile` / `AiProfileInput` | AI 配置与多 Profile |
| `AiApiType` | 三种协议：`OpenAiChatCompletions` / `OpenAiResponses` / `AnthropicMessages` |
| `PtyOutputEvent` | PTY 输出事件（推送给前端） |

所有时间戳统一用 `now_rfc3339()` → `chrono::Utc::now().to_rfc3339()`。

---

## 状态管理：AppState

[`state.rs`](src-tauri/src/state.rs) 是整个后端的"中央状态机"：

```rust
pub struct AppState {
    pub storage: Storage,                          // 持久化配置
    pub ops_agent: OpsAgentStore,                  // AI 对话存储
    pub ops_agent_attachments: OpsAgentAttachmentStore,
    pub ops_agent_tools: OpsAgentToolRegistry,     // 工具注册表
    pub ops_agent_runs: OpsAgentRunRegistry,       // 运行注册表（取消控制）
    sessions: RwLock<HashMap<String, ShellSession>>,        // 运行时会话
    pty_channels: RwLock<HashMap<String, (u64, UnboundedSender<PtyCommand>)>>, // PTY 控制通道 + 代次
    shell_connection_cancellations: RwLock<HashMap<String, CancellationToken>>, // SSH 连接取消标记
    // 插件注册表另行持有状态缓存与 SFTP 传输取消状态，见 plugins/。
}
```

**会话管理**：
- `put_session()` / `get_session()` / `remove_session()` — 增删查
- `mutate_session()` — 原子性更新（用于 `cd` 后更新当前目录）

**PTY 控制**：
- `put_pty_channel()` — 注册会话的 PTY 控制通道（tokio mpsc::UnboundedSender），返回本次注册的代次
- `send_pty_command()` — 发送 Input / Resize / Close 命令
- `remove_pty_channel()` — 关闭时清理
- `is_current_pty_generation()` / `remove_pty_channel_if_current()` — 代次校验；标签页可在旧 worker 退出前被重开，旧 worker 不得注销继任者的通道

**会话恢复**：
- `reopen_shell_pty()` — 在已有 session id 上重建 PTY channel，复用标签页传输层，不新建会话

**SSH 连接取消**：
- `begin_shell_connection()` / `cancel_shell_connection()` / `is_shell_connection_cancelled()` — 通过 request id 标记待取消的连接尝试
- TCP、握手、认证与 KI 等待通过 tokio select 响应 CancellationToken；不再轮询 bool 标记。

**SFTP 传输取消**：
- 由 `plugins/sftp/` 管理每项传输的 CancellationToken，与 tab 关闭信号一起打断等待。
- 兼容入口保留既有取消语义，包括在传输启动前到达的取消请求；插件生命周期守卫阻止在途操作期间停用。

所有 HashMap 都用 `RwLock` 保护。由于 Tauri 命令可能在多线程执行，这是必要的同步手段。

---

## 存储层

[`storage/mod.rs`](src-tauri/src/storage/mod.rs) 管理三类配置的持久化：

| 文件 | 内容 |
|------|------|
| `ssh_configs.json` | SSH 配置列表 |
| `scripts.json` | 脚本列表 |
| `ai_profiles.json` | AI Profile 列表（含活跃 profile ID、审批模式） |

**初始化流程**：
1. `create_dir_all` 确保目录存在
2. `read_json_or_default` 读取已有文件，不存在则返回默认值
3. **迁移逻辑**：如果 `ai_profiles.json` 不存在但存在 legacy `ai_config.json`，自动迁移
4. 写回所有文件（确保文件一定存在，方便调试）
5. 删除 legacy 文件

[`storage/ssh.rs`](src-tauri/src/storage/ssh.rs)、[`scripts.rs`](src-tauri/src/storage/scripts.rs)、[`ai_profiles.rs`](src-tauri/src/storage/ai_profiles.rs) 分别实现 CRUD，内部都用 `RwLock` 保护 Vec，修改后即时写回 JSON。

---

## 服务器操作层（server_ops）

核心实现拆分为 `transport/`、`service.rs`、`pty.rs` 与 `channel.rs`。SFTP 和状态监控实现已迁入 `plugins/sftp/` 与 `plugins/status/`，通过核心的窄传输接口复用连接。详见 [SSH 传输层](ssh_transport.md) 和 [内置插件架构](builtin_extensions.md)。

### SSH 连接

russh 在 tokio runtime 上建立 TCP/跳板流，验证 host key，再进行密码/私钥/KI 认证。每个标签页缓存一条连接，各功能使用独立 channel。按标签页的异步建连锁保证并发请求只握手一次；取消通过 CancellationToken 唤醒，不阻塞 runtime。

`requestId`、`cancel_open_shell_session`、主机密钥 challenge 和 KI 事件协议保持不变。keepalive 由 russh Config 管理。

### 命令执行

- 每个命令在缓存连接上打开 exec channel，不锁住 PTY/SFTP。
- 只有 channel-open 阶段发现死连接才重连重试一次；命令发送之后不重放。
- 初始 cwd 为空，不额外执行 `pwd`。未知目录或 `~` 不增加 `cd` 前缀；独立 `cd` 成功后严格解析 `pwd` 更新目录。
- 返回原 `CommandExecutionResult`，同时收集 stdout/stderr 并等待退出状态。

### PTY 交互式终端

PTY worker 是 tokio task，使用 tokio mpsc 接收 Input/Resize/Close，输出通过原 `pty-output` 事件推送。输入窗口阻塞不妨碍读取/取消；输出批量发送并保留跨包 UTF-8。异常断连发送 `pty-closed`，前端继续使用原重连入口。

worker 退出时按代次判定自己是否仍代表该标签页：被取代的 worker 不触碰会话记录，仍是当前代的 worker 在传输断开时保留记录（供 `reopen_shell_pty` 恢复）、在正常退出时删除记录。`reopen_shell_pty` 在同一 session id 上重建 channel，因此恢复不会产生孤儿标签页。

### SFTP 文件操作

基于共享 russh 连接的独立 channel，使用 russh-sftp 异步子系统：

| 函数 | 说明 |
|------|------|
| `sftp_list_dir()` | 列目录，过滤 `.` / `..` |
| `sftp_read_file()` | 读文本文件 |
| `sftp_write_file()` | 写文本文件 |
| `sftp_create_file()` | 创建空文件 |
| `sftp_create_directory()` | 创建目录 |
| `sftp_delete_entry()` | 删除文件/目录 |
| `sftp_upload_file()` | base64 解码后上传 |
| `sftp_download_file()` | 下载后 base64 编码返回 |
| `sftp_upload_file_with_progress()` | 分块上传，emit 进度事件 |
| `sftp_download_file_to_local()` | 直接下载到本地目录，emit 进度事件 |

**进度事件**：通过 `app.emit("sftp-transfer", SftpTransferEvent)` 推送，前端显示传输队列。

**创建语义**：
- 创建文件和目录使用同一个输入模型：`sessionId` + `path`
- `ensure_creatable_remote_path()` 拒绝 `/` 和已经存在的远端路径
- 前端用自定义弹窗输入文件/文件夹名，并在提交前校验空值、`.`、`..` 和斜杠

**复制路径**：右键菜单里的 `Copy Path` 是纯前端剪贴板操作，不进入后端 RPC。

### 服务器状态采集

`plugins/status/` 中的 `fetch_server_status()`：
- 按既有顺序通过核心 exec 通道执行各指标探针，采集 CPU、内存、网卡流量、进程、磁盘及 GPU 数据。
- 采样命令和解析规则原样迁移，具体语义见 [状态监控指南](../features/server_status.md)。
- 结果存入插件拥有的状态缓存，切换标签页时可秒读；写入前保留 session 存活校验。

**解析器**位于 `plugins/status/` 的指标模块中：
- 兼容 `procps top` 和 `busybox top` 两种输出格式
- 内存单位自动识别（KiB/MiB/GiB）并统一转为 MiB
- 有大量单元测试覆盖各种 top 输出格式

---

## AI 服务（旧版）

[`ai_service.rs`](src-tauri/src/ai_service.rs) 是**旧版简单 AI 问答**的实现（非 Ops Agent）：

```rust
pub async fn ask_ai(state: &AppState, input: AiAskInput) -> AppResult<AiAnswer>
```

- 读取活跃 AI Profile 的配置
- 构造 `[system, user]` 两则消息
- 调用 `request_message()`（非流式）获取完整回复
- 从回复中提取建议命令（通过解析 ` ```bash ` 代码块或 `$ ` 前缀行）

这个模块现在主要被侧边栏的"AI 问答"功能使用，Ops Agent 是更高级的交互。

---

## Ops Agent 架构总览

Ops Agent 是后端最复杂的子系统，采用**分层架构**：

```
ops_agent/
  domain/         # 领域类型（对话、消息、动作、流事件）
  tools/          # 工具系统（shell 执行、UI 上下文读取）
  core/           # 核心引擎（ReAct 循环、LLM 调用、提示词、压缩、运行时）
  providers/      # 多 Provider 适配（OpenAI/Anthropic/文本回退）
  application/    # 应用层（聊天管理、审批解析、对话压缩入口）
  infrastructure/ # 基础设施（存储、附件、日志、运行注册表）
  transport/      # 传输层（Tauri 事件发射、流事件封装）
```

---

## Ops Agent 领域模型

[`domain/types.rs`](src-tauri/src/ops_agent/domain/types.rs) 定义核心领域对象：

### 消息与会话

```rust
pub struct OpsAgentMessage {
    pub id: String,
    pub role: OpsAgentRole,       // System / User / Assistant / Tool
    pub content: String,
    pub tool_kind: Option<OpsAgentToolKind>,
    pub shell_context: Option<OpsAgentShellContext>,
    pub attachment_ids: Vec<String>,
}

pub struct OpsAgentConversation {
    pub id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub messages: Vec<OpsAgentMessage>,
}
```

### 审批动作

```rust
pub struct OpsAgentPendingAction {
    pub id: String,
    pub tool_kind: OpsAgentToolKind,
    pub risk_level: OpsAgentRiskLevel,   // Low / Medium / High
    pub conversation_id: String,
    pub session_id: Option<String>,
    pub command: String,
    pub reason: String,
    pub status: OpsAgentActionStatus,    // Pending / Rejected / Executed / Failed
    pub approval_decision: Option<OpsAgentApprovalDecision>,
    pub approval_comment: Option<String>,
}
```

### 流事件

```rust
pub enum OpsAgentStreamStage {
    Started,         # 运行开始
    Delta,           # 文本片段（流式输出）
    ToolCall,        # 工具调用声明
    ToolRead,        # 工具读取/执行结果
    RequiresApproval,# 需要用户审批
    Completed,       # 完成
    Error,           # 错误
}
```

---

## Ops Agent 工具系统

[`tools/mod.rs`](src-tauri/src/ops_agent/tools/mod.rs) 定义了工具注册表和 trait：

```rust
pub trait OpsAgentTool: Send + Sync {
    fn definition(&self) -> OpsAgentToolDefinition;
    fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> ToolFuture<OpsAgentToolOutcome>;
    fn resolve_action(self: Arc<Self>, request: OpsAgentToolResolveRequest) -> ToolFuture<OpsAgentToolResolution>;
}
```

**工具执行结果**：
- `OpsAgentToolOutcome::Executed(...)` — 直接执行成功
- `OpsAgentToolOutcome::AwaitingApproval(action)` — 需要审批，挂起

**当前注册的工具** [`default_ops_agent_tool_registry()`](src-tauri/src/ops_agent/tools/mod.rs:148)：
1. `ShellTool` — 执行 shell 命令
2. `UiContextTool` — 读取用户附加的 UI 上下文

### ShellTool 安全策略

[`tools/shell.rs`](src-tauri/src/ops_agent/tools/shell.rs) 是安全核心：

**只读命令白名单**：
- 基础命令：`ls`, `cat`, `grep`, `ps`, `df`, `free`, `ss`, `netstat` 等
- `systemctl` 只允许 `status/is-active/list` 等
- `git` 只允许 `status/log/diff/branch` 等
- `docker` 只允许 `ps/images/inspect/logs` 等
- `kubectl` 只允许 `get/describe/logs` 等

**变更命令检测**：
- `rm`, `mv`, `cp`, `touch`, `mkdir`, `chmod`, `apt`, `shutdown`, `reboot` 等会被拦截

**审批模式**：
- `RequireApproval`（默认）：只读命令直接执行，非只读命令进入审批队列
- `AutoExecute`：全部自动执行（高风险）

**风险分级**：
- `High`：`rm -rf /`, `mkfs`, `dd`, `shutdown`, `reboot` 等
- `Medium`：`systemctl restart`, `docker rm`, `kubectl apply`, `git push` 等
- `Low`：其他变更命令

**命令验证规则**：
- 禁止多行命令（`\n` / `\r`）
- 禁止链式执行（`;` / `&&` / `||`）
- 禁止输入重定向和命令替换（`<` / `` ` `` / `$()`）
- 允许管道（`|`），但每段都必须通过白名单
- 允许 `>/dev/null` 和 `2>&1` 等安全重定向

---

## Ops Agent ReAct 循环

[`core/react_loop.rs`](src-tauri/src/ops_agent/core/react_loop.rs) 是 AI 助手的"大脑"：

```
process_chat_stream():
  1. 检查取消状态
  2. 读取 runtime 已准备好的“模型用历史视图”
  3. 分割历史消息和当前用户消息
  4. 加载会话上下文和工具提示
  5. FOR step in 1..=MAX_REACT_STEPS(8):
       a. 请求 AI Planner → 得到 PlannedAgentReply（工具选择 + 命令）
       b. IF 工具 kind 是 none → 直接流式输出最终答案，结束
       c. 查找并执行工具
       d. IF 工具返回 AwaitingApproval → emit RequiresApproval，结束本轮
       e. IF 工具返回 Executed → 将结果作为 tool 消息加入历史，继续循环
  6. 如果达到最大步数仍未结束，输出超时消息
```

### Planner 阶段

[`llm::plan_reply()`](src-tauri/src/ops_agent/core/llm.rs:28)：

- 构造 system prompt（包含工具目录、会话上下文、shell 执行策略）
- 发送**非流式**请求给 AI（timeout 45s）
- 优先解析**原生 tool_calls**（OpenAI function calling / Anthropic tool use）
- 如果没有原生 tool_calls，回退到**文本解析**（`text_fallback::parse_planned_reply`）
- 返回 `PlannedAgentReply { reply, tool: { kind, command, reason } }`

### Answer 阶段

[`llm::stream_final_answer()`](src-tauri/src/ops_agent/core/llm.rs:161)：

- 当 Planner 不需要工具（`tool.kind.is_none()`）或达到步数上限时
- 构造 answer system prompt
- 发送**流式**请求给 AI（timeout 240s）
- 每个 delta 通过 `OpsAgentEventEmitter::delta()` 推送给前端
- 最终 `completed()` 事件结束

### 自动重试

Planner 和 Answer 都有重试机制：
- 最多重试 3 次
- 可重试错误：网络超时、rate limit 等
- 每次重试间隔 3 秒（分片睡眠 200ms 以便及时响应取消）

---

## 流式传输与事件系统

[`transport/events.rs`](src-tauri/src/ops_agent/transport/events.rs) 封装了 Tauri 事件发射：

```rust
pub struct OpsAgentEventEmitter {
    app: AppHandle,
    log_path: PathBuf,
    run_id: String,
    conversation_id: String,
}
```

每个阶段调用对应方法：
- `started()` → `ops-agent-stream` 事件，stage=`Started`
- `delta(chunk)` → stage=`Delta`
- `tool_call(tc)` → stage=`ToolCall`
- `requires_approval(action, tc)` → stage=`RequiresApproval`
- `completed(full_answer, pending)` → stage=`Completed`
- `error(msg)` → stage=`Error`

每次 emit 同时写入 debug log。

---

## 审批机制

[`application/approval.rs`](src-tauri/src/ops_agent/application/approval.rs)

### 审批流程

1. ShellTool 检测到命令不在只读白名单 → 创建 `OpsAgentPendingAction`（状态 `Pending`）
2. emit `RequiresApproval` 事件到前端
3. 前端显示审批面板，用户选择"批准"或"拒绝"

### 审批解析

[`resolve_pending_action()`](src-tauri/src/ops_agent/application/approval.rs:16)：

**拒绝**：
- 标记 action 状态为 `Rejected`
- 如果用户填写了拒绝理由，作为新的 user message 追加到对话
- **自动恢复 ReAct 循环**：调用 `maybe_resume_run_after_action_resolution()`

**批准**：
- 查找对应工具（`ShellTool`）
- 调用 `tool.resolve_action()` 执行命令
- 标记 action 为 `Executed` 或 `Failed`
- 将执行结果作为 `Tool` 角色的消息追加到对话
- **自动恢复 ReAct 循环**

### 自动恢复 ReAct

[`maybe_resume_run_after_action_resolution()`](src-tauri/src/ops_agent/application/approval.rs:182)：

这是整个系统最巧妙的设计之一：

1. 从对话历史中**收集当前 turn 的 tool 历史**（从源 user message 到当前的所有 tool 消息）
2. 生成新的 `run_id`
3. 在 `OpsAgentRunRegistry` 注册新运行
4. 调用 `spawn_chat_run_task()` 启动新的异步任务
5. 新任务携带 `seed_turn_tool_history`，Planner 会在此基础上继续推理

这意味着：**用户审批后，AI 会自动继续思考下一步，无需用户再次输入**。

### 运行注册表

[`infrastructure/run_registry.rs`](src-tauri/src/ops_agent/infrastructure/run_registry.rs)：

```rust
pub struct OpsAgentRunRegistry {
    inner: Arc<Mutex<OpsAgentRunRegistryInner>>,
}

struct OpsAgentRunRegistryInner {
    runs: HashMap<String, OpsAgentRunEntry>,
    conversation_to_run: HashMap<String, String>,  // 每个对话同时只能有一个运行
}
```

- `register()` — 注册新运行，如果对话已有运行则报错
- `cancel()` — 标记取消（AtomicBool）
- `finish()` — 运行结束后清理

`OpsAgentRunHandle` 携带 `Arc<AtomicBool>`，ReAct 循环每步都检查 `is_cancelled()`。

---

## 会话压缩

[`core/compaction.rs`](src-tauri/src/ops_agent/core/compaction.rs) 解决长对话的 token 超限问题，同时保持用户可见聊天历史不变。

### 自动压缩

每次 chat run 在 runtime routing 前调用 `auto_compact_conversation_if_needed()`，因此 `direct_reply`、Lite/ReAct、Pro/multi-agent 都会先获得必要的私有上下文摘要：

1. 估算当前对话的 token 数（粗略算法：字符数 / 4）
2. 如果超过 `max_context_tokens`，触发压缩
3. 从历史消息中确定**保留窗口**（尾部消息，最少保留 2 条，最多 1/4 上下文或 24k tokens）
4. 将**头部消息**送给 AI 生成摘要
5. 将摘要写入 `.eshell-data/ops_agent_context_summaries/<conversation-id>.json`
6. 不改写 `.eshell-data/ops_agent_conversations/<conversation-id>.json`
7. 不删除附件，因为旧消息仍然在用户可见历史中引用它们

如果已有私有摘要，自动压缩会先估算当前“模型上下文视图”（旧摘要 + `sourceMessageId` 之后的原始消息）。只有这个视图再次超过 `max_context_tokens` 时才继续压缩，避免因为完整可见历史越来越长而每轮重复全量摘要。

### 模型上下文视图

压缩完成后，后续模型请求不会直接使用完整可见历史，而是通过 `model_conversation_for_current_message()` 构造临时历史：

1. 读取私有摘要 snapshot
2. 找到 snapshot 记录的 `sourceMessageId`
3. 拼接：
   - 一个私有 `System` boundary message
   - 一个私有 `Assistant` summary message
   - `sourceMessageId` 之后的近期原始消息
4. 如果当前用户消息不在这个临时历史里，说明 snapshot 已不适合本轮请求，后端会忽略 snapshot 并回退完整可见历史

### 重复压缩与 summary-of-summary

每个会话只维护一个最新 snapshot。重复压缩不是从完整可见历史开头重做摘要，而是滚动合并：

1. 读取旧 snapshot，构造当前模型上下文视图
2. 对这个视图重新选择保留窗口
3. 将“旧私有 summary + 新增原文前缀”合并为一个新的扁平 summary
4. 新 snapshot 的 `sourceMessageId` 指向本轮被折叠进去的最后一个真实可见消息
5. 如果本轮只是压缩旧 summary 本身，没有新增真实可见消息被折叠，则沿用旧 `sourceMessageId`

压缩提示词明确要求模型把旧 summary 当成既有压缩状态，不要把它描述成一次对话事件，也不要生成嵌套的“summary of summary”措辞。

### 手动压缩

用户也可主动触发，走相同的 `compact_conversation_history()` 逻辑，但 mode=`Manual`。手动压缩同样只刷新私有上下文摘要，不改变聊天记录。

### 回退摘要

如果 AI 摘要请求失败，使用本地 fallback：取最近 8 条消息生成 bullet list 摘要。

---

## 多 Provider 适配层

[`providers/mod.rs`](src-tauri/src/ops_agent/providers/mod.rs) 实现了三种协议的无缝切换：

```
ProviderInterface
  ├── OpenAiChatCompletions → openai_compat.rs
  ├── OpenAiResponses       → openai_responses.rs
  └── AnthropicMessages     → anthropic.rs
```

**统一抽象**：

```rust
pub struct ProviderChatMessage {
    pub role: String,
    pub content: ProviderChatMessageContent,  // Text | Parts(文本+图片)
}

pub struct ProviderChatMessageResponse {
    pub content: String,
    pub reasoning_content: String,
    pub tool_calls: Vec<ProviderToolCall>,
}
```

**两个入口方法**：
- `request_message()` — 非流式，返回完整响应（Planner 使用）
- `stream_message()` — 流式，通过 `on_delta` 回调推送片段（Answer 使用）

**tool_calls 解析**：
- OpenAI：`choices[0].message.tool_calls`
- Anthropic：`content` 数组中 `type=tool_use` 的项
- 统一转换为 `ProviderToolCall { id, name, arguments }`

**文本回退**（[`text_fallback.rs`](src-tauri/src/ops_agent/providers/text_fallback.rs)）：
- 当模型不支持原生 function calling 时
- 解析回复文本中的 `### Action: shell` 和 `### Command: ...` 格式
- 作为兼容层支持非标准 Provider

---

## Tauri 命令层

[`commands/`](src-tauri/src/commands/) 是前端调用的入口，只做三件事：

1. **参数校验和提取**
2. **调用 service/application 层**
3. **错误转换为字符串**

```rust
#[tauri::command]
pub async fn sftp_list_dir(state: State<'_, Arc<AppState>>, input: SftpListInput) 
    -> Result<SftpListResponse, String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_list_dir(&app_state, None, input).await.map_err(to_command_error)
}
```

**异步 IO**：SSH/SFTP/MCP/Ops Agent 调用直接 await，进度传输运行在 async task。私钥解密等阻塞工作单独放到 spawn_blocking。

---

## 数据流全景图

```
前端用户输入
    ↓
[commands/ops_agent.rs] start_chat_stream()
    ↓
[application/chat.rs] 创建对话 → 追加 user message → 注册 run
    ↓
[core/runtime.rs] spawn_chat_run_task() → 异步任务
    ↓
[core/runtime.rs] 统一网关：direct_reply / lite / pro
    ├── [core/compaction.rs] 生成私有摘要并构造模型上下文（如需）
    ├── direct_reply → 单次模型回复，跳过 planner/ReAct/multi-agent
    ├── lite → [core/react_loop.rs] process_chat_stream()
    └── pro → [core/orchestrator.rs] planner/executor/reviewer/validator
        ↓
    ├── [core/llm.rs] plan_reply() → 调用 Provider
    │       ↓
    │   [providers/] OpenAI / Anthropic HTTP 请求
    │       ↓
    ├── [tools/shell.rs] ShellTool::execute()
    │       ↓
    │   [server_ops/service.rs] execute_command().await → russh channel
    │       ↓
    │   只读？直接执行 → Executed
    │   变更？创建 PendingAction → AwaitingApproval
    │       ↓
    ├── [transport/events.rs] emit ops-agent-stream 事件
    │       ↓
    └── 前端接收事件，更新 UI
```

---

## 总结

eShell 后端的设计特点：

1. **单一状态中心**：`AppState` 收敛所有运行时状态，通过 `Arc` 共享
2. **分层清晰**：domain → tools → core → application → infrastructure → transport → commands
3. **安全优先**：ShellTool 有严格的只读白名单和风险分级
4. **ReAct 循环**：Planner + Tool Executor + Answer Streamer 三阶段协作
5. **审批可恢复**：拒绝/批准后自动恢复 ReAct 循环，无需用户重复输入
6. **多协议适配**：OpenAI Chat/Responses + Anthropic Messages 统一抽象
7. **全链路日志**：ops_agent_debug.log 记录每次运行的完整上下文
8. **非破坏式会话压缩**：自动/手动生成私有上下文摘要，控制 token 消耗但不改变用户可见历史
