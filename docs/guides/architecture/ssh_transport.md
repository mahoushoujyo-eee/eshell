# SSH 传输层（russh）

## 结构

- `russh = 0.63.3`（精确锁定，关闭默认 features，启用 ring/rsa）、`russh-sftp = 2.4.0`。
- `transport/`：TCP/跳板流、TOFU 主机密钥验证、密码/私钥/passphrase/KI 认证、keepalive、错误分类。
- `state.rs`：每 tab 一个 `Arc<Connection>`；按 tab 的 tokio Mutex 防止重复握手，短时读写锁只保护内存 map。连接驱逐比较 Arc 身份，不误删新连接。
- `pty.rs`：PTY task；`service.rs`：exec、cwd、状态探测；`sftp.rs`：独立 SFTP channel；`channel.rs`：取消/退出时关闭 channel。
- Tauri、MCP bridge、Ops Agent 直接 await 网络操作；进度传输运行在独立 async task。没有 libssh2、整会话 IO 锁和跳板中继线程。

一条物理连接同时承载 PTY、exec、SFTP、状态探测。跳板链每跳需要自己的 SSH 传输，但不为不同功能重复建连。channel 仍受服务器 MaxSessions、TCP 带宽和流控约束。

## 生命周期与安全边界

- request/tab/transfer 使用 CancellationToken；KI 回复通过 oneshot，300 秒等待上限，取消时移除 pending entry。
- socket/跳板流注册取消唤醒；即使握手 future 被丢弃，也会关闭底层流。子连接取消不会反向取消标签页 token。
- keepalive 每 20 秒一次，最多 3 次未回应；不进行空闲淘汰，不引入 Grace Period。
- TOFU 保持 `SSH_HOST_KEY_TRUST_REQUIRED:` + 原 JSON challenge 协议，不自动信任新密钥或变更密钥。
- exec 仅在发送 EXEC **之前**的死连接 channel-open 失败重试一次。执行拒绝、输出中断、超时均不重放命令。
- 非交互 exec 同时收集 stdout/stderr，发送 stdin EOF，等待退出状态；没有退出状态不报告成功。
- exec 总超时 30 分钟，stdout/stderr 合计上限 64 MiB，超限返回错误而非静默截断。PTY/SFTP 没有这个总时限。
- DNS/TCP 建连阶段 45 秒上限，握手和非交互认证 30 秒，channel-open 20 秒；SFTP subsystem 回复 15 秒、SFTP 请求使用配套库 10 秒超时，清理请求最多 2 秒。

## 兼容性

所有现有 Tauri command 名称、参数、返回结构及事件 payload 保持不变；`models/` 与前端代码未改。

建连不再执行额外 `pwd`。`currentDir` 初始为空；exec 在未知目录或 `~` 时不增加 `cd`，明确的独立 `cd` 成功后才更新 cwd。SFTP 默认 `/`。文本保存仍保留临时文件 + rename，服务器拒绝替换时回退直接写入。

本实现未复制 oxideterm 的 GPL 代码，也不 vendor 其 patch。参考仓库不纳入迁移提交。

## 验证与手测

自动化测试使用 loopback russh/SFTP 服务和测试专用密钥，覆盖连接缓存、跨 tab 并发、取消、TOFU、PTY/exec 复用、SFTP 读写与 exec 并行、发送后不重放、跳板嵌套握手。存储测试使用虚构 AI 配置，不依赖开发者 API key。

发布前仍需真实主机/UI 手测（自动化不替代）：

- 密码、加密私钥/passphrase、密码回退、KI 多轮/2FA；拒绝、超时、取消。
- 未知/已变更 host key，跳板与多跳的逐跳校验。
- SFTP 大文件上传/下载期间 PTY 回显、exec 和状态轮询；取消并检查部分文件清理。
- 连接中取消、传输中关 tab、sshd 重启、网络静默断链、前端重新连接。
