# 后端架构

本文档详细描述 eShell Rust 后端（`src-tauri/src/`）的实现原理。

## 目录

- [整体架构与启动流程](#整体架构与启动流程)
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

**核心设计**：所有业务状态都收敛到 `AppState` 这一个结构体里，通过 `Arc<AppState>` 共享给所有命令处理器。

---

## 错误处理体系

[`error.rs`](src-tauri/src/error.rs) 定义了统一的错误枚举：

```rust
pub enum AppError {
    Io(std::io::Error),
    SerdeJson(serde_json::Error),
    Ssh(ssh2::Error),
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

[`models.rs`](src-tauri/src/models.rs) 集中定义了前后端共享的全部 DTO：

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
    status_cache: RwLock<HashMap<String, ServerStatus>>,    // 状态缓存
    pty_channels: RwLock<HashMap<String, Sender<PtyCommand>>>, // PTY 控制通道
    shell_connection_cancellations: RwLock<HashMap<String, bool>>, // SSH 连接取消标记
    sftp_transfer_cancellations: RwLock<HashMap<String, bool>>, // 传输取消标记
}
```

**会话管理**：
- `put_session()` / `get_session()` / `remove_session()` — 增删查
- `mutate_session()` — 原子性更新（用于 `cd` 后更新当前目录）

**PTY 控制**：
- `put_pty_channel()` — 注册会话的 PTY 控制通道（mpsc::Sender）
- `send_pty_command()` — 发送 Input / Resize / Close 命令
- `remove_pty_channel()` — 关闭时清理

**SSH 连接取消**：
- `begin_shell_connection()` / `cancel_shell_connection()` / `is_shell_connection_cancelled()` — 通过 request id 标记待取消的连接尝试
- 取消检查发生在 TCP 建连循环中；TCP 建立后 SSH handshake/auth 使用阻塞模式以兼容 `ssh2` 和不同服务器实现

**SFTP 传输取消**：
- `begin_sftp_transfer()` / `cancel_sftp_transfer()` / `is_sftp_transfer_cancelled()` — 简单的 HashMap 标记机制

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

[`server_ops/service.rs`](src-tauri/src/server_ops/service.rs) 是 SSH/PTY/SFTP/状态采集的核心实现，基于 `ssh2` crate。

### SSH 连接

```rust
fn connect(config: &SshConfig) -> AppResult<Session>
```

- `connect_with_cancellation()` 可选接收 request id
- `connect_tcp_with_cancellation()` 使用短超时 `TcpStream::connect_timeout` 循环建立 TCP，并在每轮检查取消标记
- `Session::new()` 创建 SSH 会话
- `session.handshake()` → `session.userauth_password()` 密码认证
- 连接失败时返回 `AppError::Ssh`

前端打开 SSH 会话时可传 `requestId`：
- `open_shell_session` 开始连接并注册取消标记
- 用户点击取消时调用 `cancel_open_shell_session`
- 后端命中取消标记后返回 `"SSH connection cancelled by user"`
- 取消被前端作为用户动作处理，不显示为普通连接失败

注意：取消不强行中断已经进入 libssh2 handshake/auth 的阻塞调用，这是为了避免部分服务器在非阻塞握手下返回 `Session(-9)` socket timeout。

### 命令执行

[`execute_command()`](src-tauri/src/server_ops/service.rs:128)：
- 每个命令**新开一个 SSH Session**（通过 `connect()`）
- 在远程执行 `cd <current_dir> && <command>`
- 特殊处理 `cd` 命令：解析目标目录，执行 `cd ... && pwd`，成功后更新 `session.current_dir`
- 返回 `CommandExecutionResult`（含 stdout/stderr/exit_code/duration_ms）

**为什么每个命令都新建 SSH Session？** 为了隔离：不同标签页的命令不会互相干扰工作目录。

### PTY 交互式终端

[`open_shell_session()`](src-tauri/src/server_ops/service.rs:41) → `start_pty_worker()`：

1. 连接 SSH 后，开一个 `Channel`，请求 PTY（`request_pty`）
2. 启动 Shell（`request_shell` / `exec`）
3. **启动独立线程**作为 PTY Worker：
   - 通过 `mpsc::channel` 接收前端的 `PtyCommand::Input` / `Resize` / `Close`
   - 循环读取 SSH Channel 的输出，通过 Tauri 的 `app.emit("pty-output", ...)` 推送到前端
   - 限流机制：`PTY_MAX_READ_CHUNKS_PER_TICK` 等常量防止单个会话占满 CPU

前端 `xterm.js` 收到 `"pty-output"` 事件后写入终端。

### SFTP 文件操作

基于 SSH Session 的 SFTP 子系统：

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

[`fetch_server_status()`](src-tauri/src/server_ops/service.rs)：
- 执行多个远程命令采集数据：
  - `top -bn1` → CPU + 内存
  - `cat /proc/net/dev` → 网卡流量
  - `ps -eo pid,pcpu,rss,comm --sort=-pcpu` → 进程列表
  - `df -hP` → 磁盘使用
- 结果存入 `status_cache`，切换标签页时可秒读

**解析器** [`status_parser.rs`](src-tauri/src/server_ops/status_parser.rs)：
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
  2. 自动压缩对话（如果 token 超限）
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

[`core/compaction.rs`](src-tauri/src/ops_agent/core/compaction.rs) 解决长对话的 token 超限问题：

### 自动压缩

每次 ReAct 循环开始时调用 `auto_compact_conversation_if_needed()`：

1. 估算当前对话的 token 数（粗略算法：字符数 / 4）
2. 如果超过 `max_context_tokens`，触发压缩
3. 从历史消息中确定**保留窗口**（尾部消息，最少保留 2 条，最多 1/4 上下文或 24k tokens）
4. 将**头部消息**送给 AI 生成摘要
5. 用两条消息替换头部历史：
   - System 消息："Context compaction boundary..."
   - Assistant 消息：摘要内容
6. 清理被移除消息引用的附件
7. 更新持久化存储

### 手动压缩

用户也可主动触发，走相同的 `compact_conversation_history()` 逻辑，但 mode=`Manual`。

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
    run_blocking(move || super::sftp_list_dir(&app_state, input)).await
}
```

**阻塞操作的处理**：所有涉及网络 IO 的命令（SSH/SFTP/AI 请求）都包装在 `tauri::async_runtime::spawn_blocking()` 中，避免阻塞 Tauri 的异步运行时。

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
[core/react_loop.rs] process_chat_stream()
    ├── [core/compaction.rs] 自动压缩（如需）
    ├── [core/llm.rs] plan_reply() → 调用 Provider
    │       ↓
    │   [providers/] OpenAI / Anthropic HTTP 请求
    │       ↓
    ├── [tools/shell.rs] ShellTool::execute()
    │       ↓
    │   [server_ops/service.rs] execute_command() → ssh2
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
8. **会话压缩**：自动/手动压缩长对话，控制 token 消耗
