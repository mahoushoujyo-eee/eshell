# Webshell 会话：连接复用、断连检测与重连

## 后端

- `server_ops/transport/` 使用 russh，每个标签页一条 SSH 连接，PTY、exec、SFTP 和状态探测分别打开 channel。跳板机通过 `direct-tcpip` 流逐跳握手，没有本地监听器和搬运线程。
- `server_ops/pty.rs` 使用 tokio task，输入、输出、resize、取消异步交错；输出按 8ms/128KiB 批量发送，保留跨包 UTF-8。
- russh 内建 keepalive：20 秒间隔，最多 3 次未回应。没有空闲淘汰或 Grace Period 后台重连。
- 用户关闭时取消标签页 token 并清理连接，静默退出；远端 EOF/断链时发送 `pty-closed`：`{sessionId, reason}`。
- 断链后保留标签页元数据，驱逐观测到的旧连接，避免旧 PTY 的退出清理误杀并发 exec 刚建立的新连接。显式关闭仍清理整个标签页。
- 建连不再执行 `pwd`，初始 `currentDir` 为空。exec 在未知目录或 `~` 时不拼接 `cd`；SFTP 沿用前端 `currentDir || "/"`。

## 前端（契约不变）

- `effects.js` 监听 `pty-closed`，标记断连并暂停状态轮询。
- 终端展示遮罩和重新连接按钮，保留历史输出；断连时不再发送键盘输入。
- `reconnectSession` 使用相同 SSH profile 新开会话，恢复已知工作目录，迁移日志、SFTP 路径和别名。重连是新 shell，不恢复进程环境或后台任务。
- `pty-output`、`pty-closed`、`ssh-ki-prompt`、`sftp-transfer` 的名称与字段未变。

协议细节、超时和手测清单见 [SSH 传输层](../architecture/ssh_transport.md)。
