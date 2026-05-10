# 改进计划（2026-05）

这是对 eShell 当前代码库（v1.3.5）通读后的改进建议清单。按影响面分为「安全与稳定」「UX 与功能」「工程质量」三档，每项列出问题定位、建议做法、涉及文件，方便后续逐项立项。

优先级说明：
- **P0**：安全或稳定性短板，长期不改会出事故
- **P1**：明显影响日常使用体验
- **P2**：代码健康度 / 长期维护成本

---

## P0 · 安全与稳定性

### 1. 凭据明文存储

**现状**
- `.eshell-data/ssh_configs.json` 保存 SSH 密码明文
- `.eshell-data/ai_profiles.json` 保存 AI API key 明文
- `docs/specs/project_description.md` 已声明「encrypted credential storage 不在 scope」

**风险**
- 任何能读到进程工作目录的用户/进程都能拿走全部凭据
- 仓库里 `src-tauri/.eshell-data/` 被 commit 过，历史里可能已经有真实凭据

**建议**
- 引入 `keyring` crate，将 `password` / `apiKey` 存入系统 Keychain（macOS）/ Credential Manager（Windows）/ libsecret（Linux）
- JSON 中只保留 handle，如 `password_ref: "keyring:eshell/<config-id>"`
- 启动时做一次迁移：读 legacy 明文字段 → 写 keychain → 清空明文字段 → 重写 JSON

**涉及**
- `src-tauri/Cargo.toml`（新增依赖）
- `src-tauri/src/storage/ssh.rs`
- `src-tauri/src/storage/ai_profiles.rs`
- `src-tauri/src/models.rs`（密码字段改为 `Option<String>` 用于输入）

---

### 2. 缺少 SSH Host Key 验证

**现状**
- `server_ops/service.rs::connect_with_cancellation()` 在 `session.handshake()` 后直接调 `userauth_password`
- 从未读取或校验 host key

**风险**
- 中间人攻击（MITM）：被劫持的链路可以返回假的 host key，客户端无感知
- 对运维工具来说这是硬性安全缺陷

**建议**
- handshake 后用 `session.host_key()` 拿到远端 key
- 维护 `~/.eshell-data/known_hosts`（或复用用户 `~/.ssh/known_hosts`）
- 首次连接走 TOFU（trust-on-first-use），弹窗让用户确认指纹
- 之后每次连接对比 key，不一致直接拒绝并给出明显警告

**涉及**
- `src-tauri/src/server_ops/service.rs`（`connect_*` 系列）
- 新增 `src-tauri/src/server_ops/known_hosts.rs`
- 前端新增 host key 确认对话框

---

### 3. 只支持密码认证

**现状**
- `connect_with_cancellation` 只调 `userauth_password`
- `SshConfig` 里只有 `username` + `password`

**风险**
- 大量 enterprise 环境禁用密码登录，eShell 无法使用
- 用户被迫把高权限 root 密码明文落盘

**建议**
- `SshConfig` 新增 `auth_method` 字段：`Password | PubKey { key_path, passphrase_ref? } | Agent`
- Rust 侧按分支调用：
  - `userauth_pubkey_file(username, pub_path, priv_path, passphrase)`
  - `userauth_agent(username)`（自动走 `ssh-agent` / Pageant）
- 表单里让用户选择认证方式，密码 / key 都经 keychain

**涉及**
- `src-tauri/src/models.rs`
- `src-tauri/src/server_ops/service.rs`
- `src/components/sidebar/SshConfigModal.jsx`
- `src/constants/workbench.js`（`EMPTY_SSH` 默认值）

---

### 4. 每条命令都新开一个 SSH Session

**现状**
- `execute_command`、`sftp_list_dir/read/write/create/delete/upload/download`、`fetch_server_status` 内部都各自 `connect(&config)?`
- 每次都要 TCP + SSH handshake + 密码认证

**风险**
- 用户打开一个大目录（500+ 文件），前端可能并发多次 SFTP → 多次完整握手
- 状态面板 5 秒轮询一次 → 每 5 秒一次握手
- 切目录、点预览、右键菜单 → 秒级延迟

**建议**
- `AppState` 新增 `ssh_pool: RwLock<HashMap<SessionId, Arc<Mutex<ssh2::Session>>>>`
- PTY 继续独占一个 Session（它会 `set_blocking(false)`）
- 其他一次性命令复用同一个 blocking Session，按需 `channel_session()`
- 加 keepalive（`set_keepalive(true, 20)`）+ 失效检测 + lazy reconnect
- 抽 helper：`with_session<F, T>(state, session_id, f) -> AppResult<T>`、`with_sftp<F, T>(...)`

**预计收益**：交互延迟大约减半；可以消化掉 SFTP 面板目录切换卡顿的主要来源。

**涉及**
- `src-tauri/src/state.rs`
- `src-tauri/src/server_ops/service.rs`

---

### 5. SFTP 大文件走 base64 全量内存

**现状**
- `sftp_upload_file_with_progress` 接收 `content_base64: String`
- 前端 `FileReader.readAsDataURL` 整文件 → base64 → 发给 Rust → 解码 → 分块写

**风险**
- 几百 MB 的文件：base64 膨胀到 ~1.33 倍 → 前端内存炸 → Tauri IPC 消息超大 → 渲染进程 OOM
- 下载路径已经是流式到本地目录，但上传路径还没对称

**建议**
- 新增 `sftp_upload_from_path(session_id, local_path, remote_path, transfer_id)`
- Rust 用 `File::open(local_path)` + `BufReader` + 64 KB 分块直接写 SFTP
- 前端用 `@tauri-apps/plugin-dialog` 的 open file 返回 path，不再 `readAsDataURL`
- 保留 base64 路径兼容拖拽进来的剪贴板图片等小文件

**关联**：transfer queue 现在也没持久化，app 重启会丢。可以同步把队列序列化到 `.eshell-data/sftp_transfers.json`，启动时恢复（仍只是记录；真正的断点续传可以做为后续项目）。

**涉及**
- `src-tauri/src/server_ops/commands.rs`（新增 command）
- `src-tauri/src/server_ops/service.rs`
- `src/lib/tauri-api.js`
- `src/hooks/workbench/operations.js`（uploadFile）

---

### 6. 调试日志没有 rotation

**现状**
- `.eshell-data/ops_agent_debug.log`
- `.eshell-data/server_ops_debug.log`
- 都用 `OpenOptions::append` 持续写入，无大小限制

**风险**
- 长期运行可达 GB 级别，单次启动读取都会卡
- 磁盘耗尽 → 整个 Tauri 进程写失败

**建议**
- 引入 `tracing` + `tracing-appender`
- 按日滚动（`daily`）或大小滚动（10 MB × 5 文件）
- 旧日志自动删或压缩
- 顺带统一两套 `append_*_debug_log` 为同一 logger

**涉及**
- `src-tauri/Cargo.toml`
- `src-tauri/src/ops_agent/infrastructure/logging.rs`
- `src-tauri/src/server_ops/service.rs::append_server_ops_debug_log`

---

## P1 · UX 与功能

### 7. 后端错误硬编码英文

**现状**
- `"SSH connection cancelled by user"`
- `"shell command cannot be empty"`
- `"read_shell does not allow command chaining"`
- 中文 UI 下 `toErrorMessage` 直接展示英文原文 → 体验不一致

**建议**
- `AppError` 由扁平 `String` 演化为带 code 的结构：
  ```rust
  AppError::Validation { code: "shell.chaining_forbidden", detail: String }
  ```
- Tauri 命令返回 `{ code, message, detail, retriable }` 对象
- 前端 `i18n.js` 维护 code → 本地化文案表，找不到时回退 `message`

**涉及**
- `src-tauri/src/error.rs`
- `src-tauri/src/commands/*`
- `src/lib/i18n.js`
- `src/hooks/workbench/errors.js`

---

### 8. 前端双缓冲 PTY 输出

**现状**
- `ptyOutputBySession[sessionId]` 在 React state 里累积全部历史
- `xterm.js` 内部本身就有 scrollback
- 跑一个 `yes`、`dd` 或者大量日志输出会双份内存飙升

**建议**
- 让 xterm 管 scrollback（已有 `scrollback: 10000` 之类的可配置）
- `ptyOutputBySession` 退化为「面板被卸载后短时间 replay 最后 N KB」的 ring buffer（4–16 KB 足够）
- 或者干脆把 `XtermConsole` 做成持久 mount（`key={sessionId}`，不再因为切面板卸载）

**涉及**
- `src/hooks/workbench/operations.js::appendPtyOutput`
- `src/components/panels/TerminalPanel.jsx`
- `src/components/panels/XtermConsole.jsx`

---

### 9. 壁纸用 localStorage 存 base64 会炸

**现状**
- 自定义壁纸裁切后 `localStorage.setItem("eshell:terminal-wallpaper", JSON.stringify(...))`
- localStorage 单域 5 MB 硬上限

**建议**
- 大图（超过 512 KB 或 base64 长度阈值）写入 Tauri `$APPDATA/.eshell-data/wallpapers/<id>.png`
- localStorage 只存 `{ kind: "file", fileName: "custom-abc.png" }`
- 加载时通过 Tauri 文件协议（`convertFileSrc`）读回

**涉及**
- `src/constants/workbench.js::normalizeWallpaperSelection`
- `src/components/sidebar/WallpaperModal.jsx`
- `src/components/sidebar/WallpaperCropModal.jsx`
- Tauri 后端新增存取 wallpaper 文件的命令

---

### 10. 缺少快捷键 / 命令面板 / 终端搜索

**现状**
- PTY 终端里只能靠 shell 自己的历史
- 应用内无全局快捷键：session 切换、面板切换、AI 面板显示/隐藏、文件保存
- xterm 搜索（`@xterm/addon-search`）没启用

**建议**
- Ctrl/Cmd+K：命令面板（session 切换 + 常用操作 + AI Profile 切换）
- Ctrl/Cmd+F：终端内搜索
- Ctrl/Cmd+S：保存当前编辑的文件
- Ctrl/Cmd+B：折叠 / 展开侧栏
- 顶部导出一张 shortcut cheat sheet（`?` 弹窗）

**涉及**
- `src/App.jsx`（全局 keydown 已经有一部分，扩展即可）
- 新增 `src/components/app/CommandPalette.jsx`
- `src/components/panels/XtermConsole.jsx`（挂载 search addon）

---

### 11. 状态面板只兼容 Linux / GNU

**现状**
- 解析 `top -bn1`、`free`、`/proc/net/dev`、`df -hP`、`ps -eo pid,pcpu,rss,comm`
- macOS server、*BSD 上这些命令要么不存在要么输出格式差异很大
- `status_parser.rs` 目前做了 `procps top` 和 `busybox top` 的兼容，但没处理非 Linux

**建议**
- 采集前执行 `uname -s` 决定分支：
  - Linux：当前逻辑
  - Darwin：`top -l 1`、`vm_stat`、`netstat -ibn`、`df -hP`、`ps -Ao pid,pcpu,rss,comm`
  - FreeBSD / OpenBSD：类似分支
- 或者（更彻底）采用 `docs/refer_proj` 里 server_agent 的思路：首次连接时推一个静态编译的二进制上去，后续 JSON 协议通信

**涉及**
- `src-tauri/src/server_ops/service.rs::fetch_server_status`
- `src-tauri/src/server_ops/status_parser.rs`
- 新增 os 分发逻辑

---

### 12. Ops Agent 工具集过窄

**现状**
- 只有 `ShellTool`（命令白名单）+ `UiContextTool`
- AI 要读目录、读文件、查状态只能组合 shell 命令
- 白名单维护成本高，非只读命令统统走审批

**建议** 新增以下「原生只读」工具，不经过 shell 白名单：
- `fs_list_remote(path, depth)` — 直接走 SFTP，返回 JSON 结构
- `fs_read_remote(path, max_bytes)` — 读取文本（带大小上限）
- `server_status_snapshot()` — 返回 `status_cache` 里已有数据
- `journal_read(unit, lines)` — 封装 `journalctl -u <unit> -n <lines> --no-pager`（内置调参）
- `search_file_content(path, pattern, max_matches)` — 封装 `grep -rn`（限制输出）

**收益**：结构化返回，模型解析更准；白名单只用覆盖交互类 shell 需求，不再承担「所有只读查询」职责。

**涉及**
- `src-tauri/src/ops_agent/tools/mod.rs`
- 新增 `src-tauri/src/ops_agent/tools/fs.rs`、`tools/status.rs` 等
- `src-tauri/src/ops_agent/tools/shell.rs`（精简部分职责）

---

### 13. Token 估算过粗

**现状**
- `core/compaction.rs` 用「字符数 / 4」估计 token
- 中文每字符常约等于 1 token，被严重低估
- 代码密集场景又被高估

**建议**
- 引入 `tiktoken-rs`（OpenAI 系列）和 `anthropic-tokenizer`（Anthropic）
- `ProviderInterface` 暴露 `estimate_tokens(&str) -> usize`
- 压缩触发阈值按 provider 真实估算
- 每次 provider 回来如果返回 usage，用真实值校准

**涉及**
- `src-tauri/Cargo.toml`
- `src-tauri/src/ops_agent/providers/*.rs`
- `src-tauri/src/ops_agent/core/compaction.rs`

---

### 14. 会话 / 运行态指示不够

**现状**
- Session 只有「存在 / 不存在」两态
- Ops Agent run 被取消、流中断后 UI 无反馈
- 审批通过后 AI 自动 resume 时用户感知不到

**建议**
- `ShellSession` 新增 `state` 字段：`Connecting | Connected | Reconnecting | Disconnected | Failed { reason }`
- 顶部标签用颜色点指示 state
- Ops Agent：用 `agentProgress` 扩展增加 `Resuming { after: "approval" | "rejection" }` 阶段
- `ProcessChatOutcome::Cancelled` 让前端明确显示「已取消」
- TODO.md #2 里提到的 planning/executing/reviewing 阶段显示，本项同步推进

**涉及**
- `src-tauri/src/models.rs`
- `src-tauri/src/ops_agent/transport/events.rs`
- `src/lib/ops-agent-stream.js`
- `src/components/panels/ai-assistant/*`

---

## P2 · 工程质量

### 15. SFTP 函数存在大量模板代码

**现状**
- 八个 `sftp_*` 函数开头前 4 行都是：
  ```rust
  let session = state.get_session(&input.session_id)?;
  let config = state.storage.find_ssh_config(&session.config_id)?;
  let ssh = connect(&config)?;
  let sftp = ssh.sftp()?;
  ```

**建议**
- 抽 `fn with_sftp<F, T>(state: &AppState, session_id: &str, f: F) -> AppResult<T> where F: FnOnce(&Sftp) -> AppResult<T>`
- 顺手让连接池（#4）只需要改这个 helper 一处

**涉及**
- `src-tauri/src/server_ops/service.rs`

---

### 16. Tauri 命令错误类型丢失

**现状**
- 所有命令 `Result<T, String>`，前端拿到的是纯字符串
- 无法区分 validation / network / 取消 / provider 错误

**建议**
- 定义前后端共享的 error DTO：
  ```ts
  { code: string; message: string; detail?: string; retriable: boolean }
  ```
- Tauri 命令层把 `AppError` 转成这个结构（而不是字符串）
- 前端按 code 分流：validation 走 UI notice，network 可重试，cancel 静默

**涉及**
- `src-tauri/src/error.rs`
- `src-tauri/src/commands/*`
- `src/hooks/workbench/errors.js`

与 #7 同一主线，可合并一起做。

---

### 17. 日志栈未统一

**现状**
- `ops_agent/infrastructure/logging.rs::append_debug_log`
- `server_ops/service.rs::append_server_ops_debug_log`
- 两套独立实现，格式不一致

**建议**
- 引入 `tracing` + `tracing-subscriber`，按 target 分级
- 子系统用 target 前缀（`ops_agent::*`、`server_ops::*`）
- 一份 rolling 文件 + 控制台输出（dev 模式）
- 与 #6 同一主线

**涉及**
- `src-tauri/Cargo.toml`
- `src-tauri/src/ops_agent/infrastructure/logging.rs`
- `src-tauri/src/server_ops/service.rs`

---

### 18. 测试覆盖不均

**现状**
- Rust 侧：`ops_agent/application/tests.rs` 覆盖部分 application 层；`status_parser.rs`、`tools/shell.rs` 有单测；`core/react_loop.rs`、`core/compaction.rs`、`providers/*` 基本没测试
- 前端：只有 util 层测试（`ops-agent-stream`、`ops-agent-message-rendering`、`pty-input-sender`）
- E2E：0

**建议**
- Provider 集成测试：用 `mockito` / `wiremock` 起本地 HTTP，覆盖 `openai_compat`、`openai_responses`、`anthropic` 三个分支的成功 / 流式 / 错误 / 取消路径
- Compaction 单测：构造长历史 → 触发 → 验证保留窗口 + 摘要注入
- 前端加 `@testing-library/react` 做几个 smoke test：AppWorkspace 能渲染、SshConfigModal 能提交
- 至少一条 E2E：Playwright 打开 app → mock backend → 创建会话 → 发命令 → 断言 PTY 输出

**涉及**
- `src-tauri/Cargo.toml`（dev-dependencies）
- 新增 `src-tauri/src/ops_agent/providers/tests/`
- `src/**/__tests__/`
- 新增 `e2e/` 目录

---

### 19. 仓库整洁度

**问题清单**
- 根目录 `vite-dev.log`、`vite-dev.err.log` 没进 `.gitignore`
- `src-tauri/.eshell-data/` 整个目录 commit 进仓库（含真实 ssh_configs、ai_profiles）
- `src-tauri/target-codexBMhl4V/` 看起来是临时 cargo target，不应进仓库
- `package.json` 叫 `eshell-codex`，`Cargo.toml` / `tauri.conf.json` 叫 `eshell`，不一致
- `.codex/skills/` 用 symlink 指向 `.agents/skills/`，Windows 下无开发者模式会失效

**建议**
- `.gitignore` 追加：
  ```
  vite-dev.log
  vite-dev.err.log
  src-tauri/.eshell-data/
  src-tauri/target-*/
  ```
- `git rm -r --cached src-tauri/.eshell-data src-tauri/target-*`
- 把 `.eshell-data/` 里的 AGENTS.md 这种「模板文件」移到 `src-tauri/resources/default/` 作为模板，启动时拷贝
- 统一名字为 `eshell`（除非有 marketing 原因保留 `eshell-codex`）
- `.codex/skills/` 改为 junction / 复制，或在文档里说明要求开发者模式

---

### 20. 依赖版本范围过宽

**现状**
- Cargo.toml：`tauri = { version = "2" }` 之类松散 spec
- package.json：`^` 版本号

**风险**
- 本机 `cargo build` 没问题，CI 上 minor 升级可能直接破坏 build
- 运维工具对稳定性要求高于新特性

**建议**
- Cargo 锁到小版本：`tauri = { version = "2.2", features = [] }`
- npm 先观察，必要时 pin（或依赖 `package-lock.json` 本身的锁定）
- Dependabot / renovate 按月提 PR

---

### 21. SSH 握手错误提示仅覆盖 `Session(-8)`

**现状**
- `map_handshake_error` 只对 `ErrorCode::Session(-8)` 做了中英混合友好翻译
- 其他 code（`Session(-43)` host key 不匹配、`Session(-18)` banner 读取失败等）直接透传 `ssh2::Error` 的 opaque 字符串

**建议**
- 把常见 libssh2 错误码整理成一张表，在 `map_handshake_error` 里集中翻译
- 文案同步到 `i18n.js`（与 #7 合并）

**涉及**
- `src-tauri/src/server_ops/service.rs`

---

## 建议推进顺序

分三个 milestone，让每一步都有闭环价值：

**M1 · 安全与连通性加固**
- #1 凭据加密（keyring）
- #2 host key 校验
- #3 公钥 / agent 认证
- #19 仓库清理（先清掉已泄露的 `.eshell-data/`）

**M2 · 性能与稳定**
- #4 SSH Session 复用池
- #5 SFTP 大文件流式上传
- #6 + #17 日志 rotation + `tracing` 迁移
- #15 SFTP helper 抽取（与 #4 同步）

**M3 · Agent 与体验**
- #12 Ops Agent 原生工具扩展
- #13 token 估算精度
- #14 会话 / 运行态可视化（与 `docs/TODO.md` #2 合并）
- #7 + #16 错误码结构化与 i18n
- #10 快捷键 / 命令面板
- #8、#9、#11、#18、#20、#21 穿插推进

---

## 验收标准（通用）

对每个 P0/P1 改动都应满足：
- `cargo check` + `cargo test` 通过
- `npm test` + `npm run build` 通过
- 相关文档同步更新：
  - `README.md` 若有用户可见变化
  - `docs/specs/openapi.yaml` 若有命令签名变化
  - `docs/guides/features/*.md` 若有行为变化
  - `docs/guides/architecture/*.md` 若层级或边界变化
  - `docs/releases/unreleased.md` 列出用户可见变化

---

_本文档由代码通读后产出，可随实施进度增删；已完成项建议移到 `docs/releases/unreleased.md` 或归档。_
