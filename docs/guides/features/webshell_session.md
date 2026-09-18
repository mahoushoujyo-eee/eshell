# Webshell 会话：连接复用、断连检测与重连

## 后端

- `server_ops/transport/` 使用 russh，每个标签页一条 SSH 连接，PTY、exec、SFTP 和状态探测分别打开 channel。跳板机通过 `direct-tcpip` 流逐跳握手，没有本地监听器和搬运线程。
- `server_ops/pty.rs` 使用 tokio task，输入、输出、resize、取消异步交错；输出按 8ms/128KiB 批量发送，保留跨包 UTF-8。
- russh 内建 keepalive：20 秒间隔，最多 3 次未回应。没有空闲淘汰或 Grace Period 后台重连。
- 用户关闭时取消标签页 token 并清理连接，静默退出；远端 EOF/断链时发送 `pty-closed`：`{sessionId, reason}`。
- 断链后保留标签页元数据，驱逐观测到的旧连接，避免旧 PTY 的退出清理误杀并发 exec 刚建立的新连接。显式关闭仍清理整个标签页。
- PTY 正常 `exit`（worker 以 `eof` 退出）同样保留会话记录，标签页不会消失，重连按钮仍然可用。
- 建连不再执行 `pwd`，初始 `currentDir` 为空。exec 在未知目录或 `~` 时不拼接 `cd`；SFTP 沿用前端 `currentDir || "/"`。

## 原地恢复（`reopen_shell_pty`）

`reopen_shell_pty` 在**同一个 session id** 上重建 PTY channel，复用该标签页的传输层（`cached_ssh_session` 在缓存缺失时自行重连），不新建会话。标签页、工作目录、SFTP 路径和状态缓存全部保留。

- 通道注册带 generation 标记。被取代的旧 worker 退出时不得注销继任者的 channel，也不得驱逐继任者的连接，因此退出路径上的两处清理都做了身份校验。
- 被取代的 worker 不触碰会话记录；只有仍是当前代的 worker 才会在传输断开时保留记录、在正常退出时删除记录。
- 传输层在 channel-open 阶段失败时驱逐并重连一次，与 exec 的重试策略一致。

## 前端

- `effects.js` 监听 `pty-closed`，标记断连并暂停状态轮询。
- 终端展示遮罩和重新连接按钮，保留历史输出；断连时不再发送键盘输入。
- 重连由用户点击触发，**不再自动重连**。`reopenSessionPty` 调用 `reopen_shell_pty`，session id 不变，因此无需迁移日志、SFTP 路径或状态缓存。
- 重连是新 shell，不恢复进程环境或后台任务；已知工作目录通过 `cd` 恢复。
- 错误分类：`isPtyLostError`（PTY 丢失，可恢复）触发一次原地重开；`isSessionGoneError`（标签页已删除）直接上报，不重试。
- `pty-output`、`pty-closed`、`ssh-ki-prompt`、`sftp-transfer` 的名称与字段未变；新增 `reopen_shell_pty` 命令。

## 终端剪贴板

xterm 自身不绑定 Ctrl+Shift+C/V——它只监听 DOM 的 `copy`/`paste` 事件，而 WebView 不会为其隐藏 textarea 触发这些事件。因此 `XtermConsole.jsx` 在 `attachCustomKeyEventHandler` 中显式处理：

- **Ctrl+Shift+C** 复制选区；无选区时放行，让 `^C` 照常发给远端。
- **Ctrl+Shift+V** 经 `term.paste()` 粘贴，以应用 bracketed-paste 包裹，避免多行内容被逐行执行。

协议细节、超时和手测清单见 [SSH 传输层](../architecture/ssh_transport.md)。
