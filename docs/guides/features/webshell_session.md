# Webshell 会话：断连检测与重连

记录 webshell（SSH 终端）的断连检测、UI 提示与重连机制。此前的问题：NAT/防火墙空闲超时静默断链后，终端假死且无任何提示。

## 1. 后端：检测与通知（`src-tauri/src/server_ops/service.rs`）

PTY worker（每个会话一个线程）在主循环中：

- **每 tick 调用 `ssh.keepalive_send()`**（libssh2 内部按 `set_keepalive(true, 20)` 的 20 秒间隔节流）。非阻塞模式下 libssh2 不会自己发心跳——不主动 pump 的话，静默断链的读永远 WouldBlock、写进内核缓冲区"成功"，永远发现不了。心跳发送失败（非 EAGAIN）即判定连接死亡，检测延迟约 20–40 秒。
- worker 退出路径分两类：
  - **用户主动关闭**（收到 `PtyCommand::Close`）：静默退出，不发事件；
  - **异常退出**（keepalive 失败 / EOF / 读写错误）：清理会话后 emit Tauri 事件 **`pty-closed`**：`{sessionId, reason}`，reason 形如 `connection_lost: …` / `eof` / `read_failed: …` / `write_failed: …`。

事件模型：`PtyClosedEvent`（models.rs）。诊断日志写 `.eshell-data/server_ops_debug.log`（`pty.worker.keepalive_failed` / `pty.worker.disconnected` 等）。

## 2. 前端：状态与 UI

- `useWorkbench` 维护 `disconnectedSessions`（`sessionId → reason` 映射）。`effects.js` 监听 `pty-closed` → `markSessionDisconnected`（写标记 + 追加 SYSTEM 日志行）；断连会话的**状态轮询暂停**，避免错误横幅刷屏。
- **UI 表现**（UI 优化重点）：
  - `XtermConsole.jsx` 的 `XtermDisconnectOverlay`：半透明遮罩盖在终端上（历史输出仍可见），含 WifiOff 图标、说明文案、断连原因（等宽小字）、「重新连接」按钮（busy/失败重试态）；
  - 遮罩期间键盘输入被吞掉（`disconnectedRef` 在 `onData` 里拦截）；
  - `TerminalPanel.jsx` 标签页上给断连会话加红点。
- **重连** = 复用 `operations.js` 的 `reconnectSession`：同一 SSH profile 开新会话（新 sessionId）、恢复工作目录（`cd` 回原目录）、迁移日志/状态/SFTP 路径/别名，成功后清断连标记。terminal 组件按 activeSessionId 切换会 `term.reset()`，所以重连后是干净的新 shell 画面。
- 原有的**写入失败自动重连**（`runWithSessionReconnect` 包裹 ptyWriteInput/SFTP 等）保持不变，与手动按钮共存：自动重连成功同样会清掉遮罩。

## 3. 已知边界

- 检测窗口最长约 40 秒（keepalive 间隔 20s + 等应答）；期间输入会进缓冲无回显。
- 重连是**新 shell**：进程环境、后台任务不会恢复，只恢复 cwd 与面板状态。
- UI 待优化：遮罩视觉与 ACP 面板风格未统一；断连原因是原始英文错误串，可做人话映射；红点无 tooltip 动画。
