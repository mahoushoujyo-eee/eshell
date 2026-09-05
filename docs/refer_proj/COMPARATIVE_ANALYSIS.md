# Shell 项目对比分析：Termora / Electerm / Tabby vs EShell

---

## 一、Shell / 终端会话实现思路

### 1.1 Termora（Kotlin / JVM）

**架构分层**：`SSHTerminalTab` → `PtyHostTerminalTab` → `ChannelShellPtyConnector` → SSH ChannelShell

- **连接层**：`SshClients.openClient()` 创建 Apache MINA SSH `ClientSession`，支持多种认证（密码、密钥、Agent、X11）。
- **PTY 抽象**：`ChannelShellPtyConnector` 将 SSH `ChannelShell` 的 `invertedOut/invertedIn` 流包装为 `StreamPtyConnector`，统一 `read/write/resize/waitFor/close` 接口。
- **中间件**：通过 `ZModemPtyConnectorAdaptor` 支持 ZModem 文件传输，通过 `PtyConnectorFactory.decorate()` 插件式装饰。
- **并发模型**：Kotlin 协程 `CoroutineScope(Dispatchers.IO)` 驱动终端读取循环，UI 更新切换到 `Dispatchers.Swing`。
- **会话复用**：每个 Tab 独立持有 `ClientSession`，支持端口转发隧道（`openTunnelings`）。
- **重连**：`PtyHostTerminalTab` 内置 `reconnect()` 逻辑，关闭旧 connector 后重新 `doOpenPtyConnector()`。

**亮点**：
- PTY connector 抽象干净，本地 / SSH 终端共用同一套接口
- ZModem 协议原生集成
- 协程驱动，非阻塞

### 1.2 Electerm（Node.js / Electron）

**架构分层**：`SessionBase` → `SessionSsh` / `SessionLocal`

- **SSH 连接**：使用 `ssh2` 库，`SessionSsh.remoteInitProcess()` 创建 SSH connection → `conn.shell()` 打开交互式 shell channel。
- **本地终端**：`SessionLocal` 使用 `node-pty` 库 spawn 本地 shell 进程。
- **跳板机**：`SessionSsh` 支持多级跳板机（jump host），递归 `conn.forwardOut()` 建立 TCP 转发后，再在转发通道上创建新的 SSH 连接。
- **认证链**：顺序尝试 agent → privateKey → password → keyboard-interactive，支持 2FA。
- **通信**：Electron 渲染进程通过 WebSocket 与 Node.js 后端交互，`ws.s()` 发送事件。
- **PTY 数据流**：shell channel 的 `data` 事件直接写入 WebSocket，前端 xterm.js 渲染。

**亮点**：
- 跳板机链式隧道设计成熟
- keyboard-interactive 2FA 完整支持
- WebSocket 通信松耦合

### 1.3 Tabby（TypeScript / Angular / Electron）

**架构分层**：`SSHTabComponent` → `SSHShellSession` → `SSHSession` → `russh` (Rust native binding)

- **SSH 连接**：使用 Rust 原生 `russh` 库（N-API binding），支持多种传输：直连 Socket、SOCKS 代理、HTTP 代理、ProxyCommand、Jump Channel。
- **Shell 会话**：`SSHShellSession.start()` 调用 `ssh.openShellChannel()` 获得 `russh.Channel`，订阅 `channel.data$` 驱动终端输出。
- **PTY 管理**：本地终端使用 `node-pty`，通过 `PTYDataQueue` 做数据缓冲和节流（累积最多 2^22 字节 / 50ms 间隔）防止前端 flood。
- **会话复用**：`SSHMultiplexerService` 管理 SSH session 引用计数（`ref/unref`），同一 profile 可复用已有认证会话。
- **跳板机**：递归 `setupOneSession()`，通过 `openTCPForwardChannel()` 建立隧道。
- **Electron IPC**：`PTY` 类通过 `Electron.ipcRenderer` 传递 PTY 数据。

**亮点**：
- Rust 原生 SSH 实现，性能最优
- Session multiplexer 引用计数，避免重复认证
- PTYDataQueue 流控设计精细
- 完整的代理链支持（SOCKS/HTTP/ProxyCommand/Jump）

### 1.4 EShell（Rust Tauri 后端 + React 前端）

**架构**：`tauri-api.js` → Tauri invoke → `service.rs` → `ssh2` crate

- **SSH 连接**：使用 Rust `ssh2` crate，`connect_with_cancellation()` 实现带取消的 TCP 连接 + SSH 握手 + host key 验证 + 认证。
- **PTY 工作线程**：`start_pty_worker()` 在独立 `std::thread` 中运行 `run_pty_worker()` 循环：
  - `mpsc::channel` 接收前端指令（Input/Resize/Close）
  - 每个 tick 批量 drain 命令（`drain_pty_command_batch`，最多 64 条）
  - 非阻塞读写 SSH channel，16KB 缓冲区
  - 空闲时 sleep 8ms
- **前端通信**：Tauri `app.emit("pty-output", ...)` 推送数据，前端 xterm.js 渲染。
- **认证**：支持密码和私钥认证，私钥认证失败可 fallback 到密码。

---

## 二、SFTP 实现思路

### 2.1 Termora

- **协议层**：`SFTPTransferProtocolProvider` 使用 Apache MINA `SftpClientFactory.createSftpFileSystem()` 创建虚拟文件系统。
- **路径抽象**：`SFTPPathHandler` 包装文件系统操作（list/read/write/delete/rename/chmod）。
- **传输管理**：`DefaultInternalTransferManager` 支持：
  - 递归文件夹传输
  - 多种传输模式（删除 → 传输 → 修改权限）
  - 用户确认对话框（覆盖/跳过/取消）
  - 协程异步执行 + 进度状态管理
- **GUI**：拖拽式双面板文件管理器，支持并发传输。

### 2.2 Electerm

- **协议层**：`sftp-file.js` 使用 `ssh2` 的 SFTP stream API（`createReadStream/createWriteStream`）。
- **传输引擎**：`Transfer` 类实现高性能并发传输：
  - `fastXfer()`：手动管理并发读写（默认 64 并发 × 32KB chunk）
  - `ssh2ScpTransfer()`：fallback 到 SCP 传输
  - 支持 pause/resume/destroy 控制
  - `onData` 通过 `lodash.throttle` 节流 3 秒推送进度
- **前端 UI**：`sftp-entry.jsx` 实现完整的双面板文件管理器：
  - 本地（`fs`）和远程（SFTP）并列
  - 路径历史、地址栏、书签
  - 隐藏文件开关、关键词过滤、排序
  - 符号链接解析
  - 自动刷新（切换到 SFTP 面板时）
  - CWD 跟随 SSH 终端
- **传输列表**：`transfer-list.js` 全局管理传输队列、历史记录。

### 2.3 Tabby

- **协议层**：`SFTPSession` 包装 `russh.SFTP`，提供 readdir/stat/open/mkdir/rmdir/rename/unlink/chmod。
- **文件句柄**：`SFTPFileHandle` 以 256KB chunk 读写。
- **上传**：写入临时文件（`.tabby-upload`），完成后 rename 为目标路径，失败时清理临时文件。
- **下载**：文件夹下载并行计算大小 + 递归下载（`Promise.all([sizeCalc, download])`）。
- **前端 UI**：`SFTPPanelComponent` 嵌入 SSH Tab 侧边栏：
  - 路径导航（面包屑 + 编辑框）
  - 文件类型图标识别（20+ 扩展名分类）
  - 文件/文件夹上传下载
  - 右键菜单（可插件扩展）
  - 关键词过滤

### 2.4 EShell

- **协议层**：`service.rs` 中每次 SFTP 操作创建新 SSH 连接 → `ssh.sftp()` 获取 SFTP channel。
- **操作集**：list_dir / read_file / write_file / create_file / create_directory / delete_entry / upload / download。
- **上传**：`sftp_upload_file_with_progress()` 接收 base64 编码的完整文件内容，64KB chunk 写入，通过 Tauri event 推送进度。
- **下载**：`sftp_download_file()` 读取全部内容返回 base64；`sftp_download_file_to_local()` 支持流式下载到本地文件 + 进度事件。
- **取消**：`SftpTransferGuard` RAII 模式管理传输状态，支持取消正在进行的传输。
- **前端**：`sftp-transfer.js` 规范化传输事件，`upsertSftpTransfer` 管理传输列表（最多 30 条）。

---

## 三、系统指标（CPU / Memory / Disk / GPU）采集与刷新

### 3.1 Termora

**最成熟的实现**，提供两个独立的 Visual Window：

#### SystemInformationVisualWindow
- **采集方式**：通过 SSH `execChannel()` 执行 `top -bn1` 获取 CPU 和内存数据。
- **解析**：正则解析 `%Cpu(s):` 行提取 us/sy/ni/id/wa/hi/si/st 8 项指标；解析 `MiB Mem/KiB Mem/MiB Swap/KiB Swap` 行获取内存/交换分区用量。
- **磁盘**：执行 `df -B1`，解析 `/dev/` 开头的行获取文件系统、大小、已用、可用、使用百分比、挂载点。
- **UI**：进度条显示 CPU%、内存用量、交换分区用量；表格显示磁盘分区。
- **刷新机制**：`AutoRefreshPanel` 基类，协程循环 `while(isActive) { refresh(); delay(1000ms) }`，每秒自动刷新。首次失败则停止轮询。

#### NvidiaSMIVisualWindow
- **采集方式**：执行 `nvidia-smi -x -q` 获取 XML 格式 GPU 信息。
- **解析**：XPath 提取 driver_version、cuda_version、attached_gpus，每个 GPU 的 product_name、minor_number、温度、功耗、显存、GPU 利用率。
- **UI**：多 GPU 网格布局，每个 GPU 显示 GPU%、温度、显存、功耗进度条。支持百分比/文本切换。
- **刷新**：同样使用 `AutoRefreshPanel`，1 秒间隔轮询。首次检测不到 nvidia-smi 则直接取消轮询，显示 "Not supported"。

### 3.2 Electerm

- **无内置系统监控面板**。Electerm 专注于终端和文件管理，不提供 CPU/Memory/GPU 可视化。
- 用户需要在终端中手动运行 `top`/`htop` 等命令。

### 3.3 Tabby

- **无内置系统监控面板**。Tabby 同样专注于终端连接，不提供服务器指标采集。
- 通过插件生态可能扩展，但核心代码中无相关实现。

### 3.4 EShell

- **采集方式**：`fetch_server_status()` 通过 SSH 执行多条命令：
  - `LANG=C top -bn1 | head -n 10` → CPU% 和内存
  - `cat /proc/net/dev` → 网络接口流量
  - `ps -eo pid,pcpu,rss,comm --sort=-pcpu | head -n 5` → Top 进程
  - `df -hP` → 磁盘分区
- **解析**：`status_parser.rs` 提供独立的解析器函数，支持 procps top 和 busybox top 两种格式，支持 KiB/MiB/GiB 单位自动转换。
- **缓存**：`put_cached_status()` / `get_cached_server_status()` 缓存上次查询结果。
- **刷新机制**：前端按需调用 `fetchServerStatus()`，**非自动轮询**。

---

## 四、EShell 当前不足与改进建议

### 4.1 Shell / 终端会话

| 对比维度 | Termora / Electerm / Tabby | EShell 现状 | 差距 |
|---------|---------------------------|-------------|------|
| **SSH 连接复用** | Tabby 有 session multiplexer 引用计数；Termora 每 tab 独立 session | 每次 SFTP 操作都创建新 SSH 连接 `connect()` | ⚠️ **严重**：SFTP 操作频繁创建/销毁 SSH 连接，性能差、资源浪费 |
| **跳板机 / 多跳 SSH** | Electerm 和 Tabby 支持多级 jump host | 不支持 | ⚠️ 缺失关键企业功能 |
| **代理支持** | Tabby 支持 SOCKS/HTTP/ProxyCommand；Electerm 支持 SOCKS | 不支持 | ⚠️ 缺失 |
| **keyboard-interactive 认证** | Electerm 和 Tabby 完整支持 2FA | 仅支持 password + privateKey | ⚠️ 缺失 |
| **Agent 转发** | Termora、Tabby、Electerm 全部支持 | 不支持 | ⚠️ 缺失 |
| **X11 转发** | Termora、Tabby、Electerm 全部支持 | 不支持 | 低优先级 |
| **PTY 流控** | Tabby 的 PTYDataQueue 精细节流（max buffer + interval）| 固定 16KB buffer + 8ms sleep | ⚠️ 可优化：高吞吐场景下可能丢帧或延迟 |
| **ZModem** | Termora 原生支持 | 不支持 | 低优先级 |
| **SSH 算法协商** | Tabby 前端可配置每种算法类型 | 依赖 ssh2 crate 默认算法集 | 中优先级 |
| **会话重连** | Termora 内置 reconnect；Tabby 有 session multiplex 恢复 | 需手动重新打开 | ⚠️ 中优先级 |
| **端口转发** | Termora 和 Tabby 支持本地/远程端口转发 | 不支持 | 中优先级 |
| **keepalive** | ssh2 crate 设置了 20s keepalive | ✅ 已实现 | — |
| **host key 验证** | 全部项目支持 | ✅ 已实现 | — |

### 4.2 SFTP / 文件传输

| 对比维度 | 参考项目 | EShell 现状 | 差距 |
|---------|---------|-------------|------|
| **连接复用** | 所有项目复用已有 SSH session 的 SFTP channel | 每次操作创建新 SSH 连接 | ⚠️ **严重**：严重影响性能和用户体验 |
| **并发传输** | Electerm 支持 64 并发 chunk 读写；Termora 支持并发传输任务 | 串行单文件传输 | ⚠️ 大文件传输速度受限 |
| **传输暂停/恢复** | Electerm 支持 pause/resume | 仅支持取消 | 中优先级 |
| **文件夹上传** | Tabby 递归上传文件夹 | 需逐文件上传 | ⚠️ 用户体验差 |
| **文件夹下载** | Tabby 并行计算大小 + 递归下载 | 不支持文件夹下载 | ⚠️ 缺失 |
| **双面板文件管理器** | Electerm 本地 + 远程双面板 | 仅远程文件浏览 | ⚠️ 缺失本地面板 |
| **上传方式** | 流式读取本地文件 | base64 编码全部内容传给后端 | ⚠️ **严重**：大文件时内存占用极高 |
| **符号链接处理** | Electerm 解析 symlink 指向；Tabby readlink + stat | 识别 symlink 类型但不解析目标 | 中优先级 |
| **原子写入** | Tabby 写入临时文件后 rename | 直接 create 覆盖 | 中优先级：异常中断可能导致文件损坏 |
| **进度推送** | Electerm throttle 3s；EShell 每 chunk | ✅ 已实现，但每 64KB chunk 都推送可能过于频繁 | 应加 throttle |
| **路径书签/历史** | Electerm 有路径历史和书签 | 不支持 | 低优先级 |
| **文件编辑** | Electerm 支持远程文件在线编辑 | read_file + write_file 基础支持 | ✅ 基本可用 |
| **权限显示/修改** | Tabby 显示 rwx 权限字符串；Electerm 有权限编辑 UI | 不支持 | 低优先级 |
| **传输历史** | Electerm 有全局传输历史记录 | 最多保存 30 条，无持久化 | 低优先级 |

### 4.3 系统指标监控

| 对比维度 | Termora | EShell 现状 | 差距 |
|---------|---------|-------------|------|
| **自动刷新** | 协程循环 1 秒自动轮询 | 前端按需手动调用 | ⚠️ 应支持自动刷新 |
| **CPU 细分** | 解析 us/sy/ni/id/wa/hi/si/st 8 项 | 仅计算总 CPU% | 中优先级 |
| **GPU 监控** | nvidia-smi XML 解析，支持多 GPU | 不支持 | 低优先级（特定场景需求） |
| **网络流量** | 不支持 | ✅ 已实现 `/proc/net/dev` 解析 | EShell 领先 |
| **Top 进程** | 不支持 | ✅ 已实现 `ps -eo` 解析 | EShell 领先 |
| **busybox 兼容** | Termora 支持 MiB/KiB 前缀 | ✅ 已实现 procps + busybox 双格式 | — |
| **缓存** | 无缓存（每次实时查询） | ✅ 有缓存层 | EShell 更好 |
| **错误容忍** | 首次失败停止轮询 | 由前端控制重试 | — |

### 4.4 优先改进建议（按重要性排序）

#### P0 - 必须修复
1. **SFTP 连接复用**：当前每次 SFTP 操作都 `connect()` 新建 SSH 连接。应为每个 session 维护一个长连接的 SFTP channel，所有文件操作复用该 channel。
2. **上传流式化**：取消 base64 全量编码方式，改用 Tauri 的 file stream 或分片上传，避免大文件时前端/后端内存爆炸。
3. **文件夹上传/下载**：递归遍历 + 并行传输。

#### P1 - 高优先级
4. **跳板机 / Jump Host**：企业环境必备功能。
5. **keyboard-interactive 认证**：支持 2FA 场景。
6. **自动刷新监控面板**：前端 setInterval 或后端推送，支持 1-5 秒可配间隔。
7. **传输并发**：至少支持多文件并行传输。
8. **本地文件面板**：实现本地 ↔ 远程双面板文件管理器。

#### P2 - 中优先级
9. **SSH Agent 转发**
10. **端口转发（本地/远程）**
11. **进度推送节流**：当前每 64KB 推送一次，大文件时前端事件风暴。应 throttle 到 100-500ms 间隔。
12. **会话重连机制**
13. **原子文件写入**（临时文件 + rename）
14. **符号链接解析**

#### P3 - 低优先级
15. SOCKS/HTTP 代理支持
16. GPU 监控
17. ZModem 文件传输
18. X11 转发
19. SSH 算法可配置
20. 路径书签和历史

---

## 五、架构设计模式总结

| 设计模式 | Termora | Electerm | Tabby | EShell |
|---------|---------|----------|-------|--------|
| SSH 库 | Apache MINA (Java) | ssh2 (Node.js) | russh (Rust N-API) | ssh2 (Rust crate) |
| PTY 抽象 | StreamPtyConnector 接口 | node-pty class | PTY + PTYDataQueue | 直接操作 ssh2::Channel |
| 并发模型 | Kotlin 协程 | Node.js event loop | RxJS Observable + async | std::thread + mpsc |
| 前后端通信 | JVM 内部 Swing 事件 | WebSocket | Electron IPC + RxJS | Tauri invoke + emit |
| SFTP 抽象 | SftpFileSystem 虚拟 FS | ssh2 SFTP stream | russh SFTP 包装 | ssh2 crate SFTP |
| 插件系统 | ✅ Plugin API | ✅ 部分 | ✅ Angular DI | ❌ 无 |
| 国际化 | ✅ | ✅ | ✅ Angular i18n | ✅ i18n.js |

---

---

## 六、Termora TransportPanel UX 深度解析（补充）

> 当前用户正在查看的 `TransportPanel.kt` 是 Termora SFTP 面板的核心实现，其 UX 设计远超其他项目，值得专门记录。

### 6.1 导航系统

| 特性 | 实现方式 |
|-----|---------|
| **前进/后退** | `MyUndoManager`（limit=128）记录每次 `workdir` 变更，`back()/forward()` 调用 `undo()/redo()`，类似浏览器历史 |
| **历史记录** | `LinkedHashSet<Path>` 保存所有访问路径，工具栏下拉可快速跳转 |
| **书签** | `BookmarkButton` 持久化当前路径，按 `actionCommand` 区分添加/删除/跳转 |
| **快速定位** | 文件列表按首字母键跳转（`KeyAdapter` 轮询文件名首字符） |
| **Windows 盘符** | 路径为 `fileSystem.separator` 时特殊渲染盘符列表（`rootDirectories`） |
| **鼠标侧键** | Button4/5 触发 `back()/forward()`（GitHub issue #401） |

### 6.2 文件列表加载策略

- **流式渲染**：`listFiles()` 返回 `Stream<Pair<Path,Attributes>>`，每累积 50 条即 `withContext(Swing)` 刷新一次表格，避免大目录卡 UI。
- **排序**：目录优先 + 原生字符串比较器（`NativeStringComparator`），支持列头点击排序，右键列头清空排序。
- **隐藏文件**：眼睛按钮切换 `showHiddenFiles`，过滤 `.` 开头文件，状态持久化（`EnableManager`）。
- **加载动画**：150ms 延迟才显示 spinner（避免快速加载的闪烁），`JLayeredPane` 覆盖在文件列表之上。
- **完成回调**：`nextReloadCallbacks` Map 按 `mod` 版本号管理，加载完成后自动恢复已选行并维持滚动位置。

### 6.3 传输触发与自动刷新

```kotlin
// 传输完成后自动刷新目标目录（TransportPanel.initEvents）
internalTransferManager.addTransferListener { transfer, state ->
    if (state == Done || state == Failed) {
        if (target.pathString == workdir?.pathString || target.parent.pathString == workdir?.pathString) {
            reload()  // 自动刷新
        }
    }
}
```

- 传输完成（Done/Failed）时，**自动检测目标路径是否是当前工作目录**，若是则自动刷新文件列表。
- 若此时正在加载（`loading==true`），则注册到 `nextReloadCallbacks` 延迟执行，避免并发冲突。

### 6.4 拖拽传输（Drag & Drop）

`initTransferHandler()` 实现完整的 Swing DnD：
- **拖出**：`createTransferable()` 将选中文件包装为自定义 `TransferTransferable`（MIME: `termora/transfers`）。
- **拖入**：
  - 同面板内：识别 `TransferTransferable`，调用 `internalTransferManager.addTransfer()`。
  - 跨面板（双面板间）：通过 `transferTransferable.component != panel` 判断，支持本地→远程、远程→本地传输。
  - 操作系统拖入：识别 `DataFlavor.javaFileListFlavor`（从桌面/文件管理器拖入本地文件上传）。
- **目标行检测**：拖到目录行时目标变为该子目录；拖到空白处则目标为当前 `workdir`。

### 6.5 远程文件在线编辑（最精细的功能）

`EditTransferListener` + `listenFileChanged()` 实现"编辑远程文件"工作流：

```
双击文件（dbClickBehavior == "Edit"）
  → addHighTransfer(remotePath → localTempFile)
  → 下载完成后启动本地编辑器（notepad/TextEdit/自定义命令）
  → 协程每 1 秒检查本地文件 mtime
  → 文件修改时自动 addHighTransfer(localTempFile → remotePath) 同步回服务器
  → 编辑器关闭时停止监听
```

**EShell 对比**：EShell 的 `FileEditorModal` 只支持手动点击保存，没有文件变更监听 + 自动同步机制。

### 6.6 右键菜单操作集

`TransportPopupMenu.ActionCommand` 枚举涵盖：

| 操作 | 说明 |
|-----|-----|
| `Transfer` | 传输到对侧面板 |
| `Delete` | 弹确认框删除 |
| `Rmrf` | 强制递归删除（不确认） |
| `Edit` | 下载→本地编辑器→自动同步 |
| `NewFolder/NewFile` | 在当前目录创建 |
| `Rename` | 行内重命名 |
| `ChangePermissions` | chmod，支持递归子目录 |
| `Copy/Paste` | 面板间复制粘贴 |
| `Refresh` | 刷新并保持选中行 |
| `Reconnect` | 断线重连 |

**EShell SFTP 右键菜单现状**：Open / Download / Copy Path / Delete，仅 4 项，差距很大。

---

## 七、系统状态面板刷新策略详细对比

### 7.1 刷新触发时机

| 项目 | 刷新策略 | 条件控制 |
|-----|---------|---------|
| **Termora** | 协程 `while(isActive) { refresh(); delay(1000ms) }` | 始终轮询，窗口销毁时 `coroutineScope.cancel()` |
| **EShell** | `setInterval(refreshStatus, 5000)` | **仅当 `showSftpPanel || showStatusPanel` 时**才启动轮询，面板隐藏即停止 |
| **Electerm** | 无 | — |
| **Tabby** | 无 | — |

EShell 的条件控制实际上是**更优的设计**——Termora 的 Visual Window 关闭时才停止，而 EShell 在面板不可见时就停止轮询，减少不必要的 SSH 命令开销。

**但 EShell 的 5 秒间隔 vs Termora 的 1 秒间隔**差距较大，对于监控场景实时性不足。

### 7.2 EShell 刷新的核心问题

```js
// effects.js - 每次刷新都创建新 SSH 连接
const refreshStatus = async (sessionId, nic) => {
    // → invoke("fetch_server_status")
    // → service.rs: connect() → SSH 握手 → top/df/ps → 断开
}
```

每次 `fetch_server_status` 调用都完整执行：TCP 连接 → SSH 握手 → 认证 → 执行命令 → 断开。5 秒一次还勉强可接受，但如果改为 1 秒刷新则完全不可行。**根本解决方案是 SSH 连接复用**。

### 7.3 改进方向

```
短期：将 fetch_server_status 改为复用 PTY session 的已有 SSH 连接（run_channel_command 在现有 session 上执行）
中期：支持可配置刷新间隔（1s/3s/5s/10s）
长期：考虑 SSH 连接池，SFTP + 状态查询 + 脚本执行共用同一连接
```

---

## 八、SFTP 面板布局深度对比

### 8.1 布局模型

| 项目 | 布局 | 本地面板 | 路径历史 | 书签 |
|-----|-----|---------|---------|-----|
| **Termora** | 双面板（本地+远程），独立 TransportPanel | ✅ 本地 FS | ✅ UndoManager（128步） | ✅ 持久化 |
| **Electerm** | 双面板（`local` / `remote` 并列），自定义 | ✅ node fs | ✅ 最多 maxSftpHistory | ✅ 地址书签 |
| **Tabby** | 单面板（远程），侧边栏抽屉式弹出 | ❌ 无 | ❌ 无 | ❌ 无 |
| **EShell** | 左树+右列表（仅远程），侧边面板 | ❌ 无 | ❌ 无 | ❌ 无 |

### 8.2 文件列表功能矩阵

| 功能 | Termora | Electerm | Tabby | EShell |
|-----|---------|----------|-------|--------|
| 文件图标 | ✅ 系统原生图标（Windows/Linux） | ✅ 文件类型图标 | ✅ FontAwesome 分类图标 | ❌ 无图标 |
| 权限列 | ✅ `rwxrwxrwx` 格式 | ✅ 可编辑 | ✅ 权限字符串 | ❌ 无 |
| 文件所有者列 | ✅ owner 字段 | ✅ uid/gid 解析 | ❌ 无 | ❌ 无 |
| 修改时间列 | ✅ | ✅ | ✅ | ✅ |
| 文件大小列 | ✅ | ✅ | ✅ | ✅ |
| 列排序 | ✅ 支持所有列，本地化字符串比较 | ✅ 多列排序 | ✅ 名称/目录优先 | ❌ 无排序 |
| 关键词过滤 | ❌ 无 | ✅ keyword 实时过滤 | ✅ filter 开关 | ❌ 无 |
| 隐藏文件 | ✅ 眼睛按钮 | ✅ showHiddenFile 开关 | ❌ 无 | ❌ 无 |
| 符号链接 | ✅ 识别并显示类型 | ✅ 解析真实路径 | ✅ readlink+stat | ✅ 识别但不解析 |
| 多选 | ✅ Shift/Ctrl 多选 | ✅ Set<id> | ✅ | ❌ 单选 |
| 拖拽传输 | ✅ 完整 DnD（面板间+系统拖入） | ✅ 拖拽上传 | ❌ 无 | ❌ 无 |

### 8.3 EShell SFTP 架构特点

EShell 的 `SftpPanel.jsx` 采用了**树形导航 + 列表**的双栏布局：
- 左侧：`SftpTreePane` — 目录树，懒加载，记忆展开状态。
- 右侧：`SftpEntriesPane` — 当前目录文件列表。

这比 Electerm/Termora 的传统双面板（本地+远程）**更适合纯远程文件浏览场景**，但缺少本地面板导致无法直接拖拽传输。

---

## 九、综合优先级改进清单（修订版）

### P0 — 架构级缺陷（必须修复）

1. **SSH 连接复用**：为每个 `session_id` 维护长连接 SSH + SFTP channel，所有操作复用。当前的"每次操作建连"是最严重的性能问题。
2. **上传去 base64 化**：前端不应读取完整文件内容到内存再 base64 编码。应使用 Tauri 的文件选择器 API 返回本地路径，后端直接流式读取文件上传。
3. **SFTP 操作连接池**：解决 P0.1 后，状态查询（CPU/内存）也可复用同一连接，消除 5s 轮询时的握手延迟。

### P1 — 高价值功能（用户强需求）

4. **文件夹上传/下载**：递归遍历 + 并行传输。
5. **拖拽上传**：支持从 OS 拖拽文件到 SFTP 面板触发上传。
6. **跳板机 / Jump Host**：企业环境必备。
7. **多选操作**：多选文件批量下载/删除/传输。
8. **文件列表排序**：按名称/大小/修改时间排序。
9. **状态刷新间隔可配置**：默认 5s，允许调整为 1s/3s/10s。
10. **传输完成后自动刷新目录**：模仿 Termora，传输成功后自动 reload 当前目录。

### P2 — 体验改善

11. **文件图标**：基于扩展名显示分类图标。
12. **隐藏文件显示开关**。
13. **关键词过滤**。
14. **路径书签**。
15. **远程文件在线编辑**（改进为"保存时自动上传"，类似 Termora 的 EditTransferListener）。
16. **keyboard-interactive 2FA 认证**。
17. **进度推送节流**（当前每 64KB 发一次事件，应 throttle 到 200ms）。
18. **SSH Agent 转发**。

### P3 — 长尾功能

19. 端口转发（本地/远程）。
20. 文件权限显示与修改。
21. 传输暂停/恢复。
22. SOCKS/HTTP 代理。
23. 连接重连机制。
24. 原子写入（临时文件 + rename）。
25. GPU 监控（nvidia-smi）。

---

---

## 十、各项目功能亮点全景（按项目逐一梳理）

> 本节系统梳理 Termora / Electerm / Tabby 中所有值得 EShell 参考的功能设计，覆盖前述章节未详细记录的部分。

---

### 10.1 Termora 功能亮点全集

#### A. SSH 连接配置（SSHHostOptionsPane）

Termora 的连接配置页分为 6 个选项卡，每项配置精细：

| 选项卡 | 内容 |
|-------|-----|
| **General** | 主机/端口/用户名/密码/公钥/SSH Agent 三种认证类型切换 |
| **Proxy** | HTTP/SOCKS 代理，支持代理认证（用户名+密码） |
| **Tunneling** | 端口转发列表（本地/远程/动态），X11 转发开关+服务器地址，Agent 转发开关 |
| **Jump Hosts** | 多级跳板机链（`List<Host>`），从现有主机列表选择 |
| **Terminal** | 字符集/字体/环境变量/Backspace键行为/心跳间隔/超时/高亮规则集/登录脚本/启动命令 |
| **SFTP** | 默认目录配置 |

**EShell 现状**：仅有 General（主机/端口/用户/密码/私钥）+ 无其余选项卡。

---

#### B. SSH Session Pool（SshSessionPool）

`SshSessionPool` 用 `WeakHashMap<ClientSession, MyClientSession>` 实现引用计数的 session 池：

```kotlin
fun register(session: ClientSession, client: SshClient): ClientSession {
    // 包装为 MyClientSession，refCount++
    // close() 时 refCount--，归零才真正断开
}
```

- Shell channel、SFTP channel、exec channel 全部**复用同一 ClientSession**
- `close()` 拦截：引用计数 > 0 时返回假 CloseFuture（不真正断开）
- 终端 tab、SFTP 面板、系统监控三者共享一条 TCP 连接

**EShell 问题**：无 session pool，每次 SFTP/监控操作都新建连接。

---

#### C. 传输管理器（DefaultInternalTransferManager）

**文件冲突对话框**：目标文件已存在时弹出精细的冲突确认框，显示：
- 文件名、源/目标图标、修改时间对比
- 操作下拉：`Overwrite`（覆盖）/ `Skip`（跳过）
- `Apply to All` 复选框：一次决定应用于所有冲突文件

**传输模式枚举**：
```kotlin
enum class TransferMode {
    Transfer,         // 普通传输（上传/下载）
    Delete,           // 逐文件删除（确认）
    Rmrf,             // rm -rf（直接执行，跳过 Java 文件遍历）
    ChangePermission, // chmod，可递归子目录
}
```

**递归目录传输**（`doAddTransfer`）：
- 使用 `Files.walkFileTree` + `FileVisitor` 遍历目录树
- 父目录 Transfer 和子文件 Transfer 通过 `parentId` 关联，形成树形传输任务
- `TransferScanner` 标记扫描中的目录节点，扫描完成后调用 `scanned()` 通知进度
- 传输被取消时（`future.isCancelled`）立即终止遍历

**文件修改时间保留**（FileTransfer）：
```kotlin
if (isPreserveModificationTime) {
    Files.setLastModifiedTime(target(), source().getLastModifiedTime())
}
```

---

#### D. 传输表格 UI（TransferTable / TransferTableModel）

- 树形传输列表：父节点（目录）+ 子节点（文件），展开/收起
- 每行显示：文件名/状态/进度条/速度/已传/总大小
- 状态枚举：`Queued / Scanning / Running / Done / Failed / Cancelled`
- 传输优先级：`Normal` / `High`（高优先级任务如"编辑"插队到队首）

---

#### E. 关键词高亮（Keyword Highlight）

- 终端输出支持**自定义关键词高亮规则集**（颜色 + 正则/字符串）
- 每个主机可绑定不同的高亮规则集
- 在连接配置的 Terminal 选项卡中选择

**EShell 现状**：无关键词高亮。

---

#### F. 登录脚本（Login Scripts）

`loginScripts` 字段：连接成功后按顺序自动发送的命令序列（如 `sudo su -`、`cd /var/log`）

- 支持条件触发（等待特定输出后再发送）
- 在 Terminal 选项卡可视化编辑

**EShell 现状**：无登录脚本（连接后需手动输入）。

---

#### G. 端口转发（Tunnelings）

- 本地端口转发：`localPort → remoteHost:remotePort`
- 远程端口转发：`remotePort → localHost:localPort`
- 动态端口转发（SOCKS 代理）
- 连接配置中可预设多条隧道，连接后自动建立

**EShell 现状**：无端口转发支持。

---

#### H. 多协议支持（插件）

Termora 通过 `Plugin API` 支持多种协议：
- SSH（内建）
- Telnet（内建插件）
- 本地 Shell（内建插件）
- WSL（Windows Subsystem for Linux，内建插件）
- RDP（内建插件框架）
- SFTP-only 模式（`sftppty` 插件，不开 Shell 直接 SFTP）

---

#### I. VisualWindow 系统（浮动监控窗口）

- 监控面板可以**弹出为独立浮动窗口**（`toggleWindow()`），也可以嵌入终端侧边栏
- `VisualWindowManager` 管理所有已打开的监控窗口
- `ServerInfoVisualWindowActionExtension` 将"服务器信息"按钮注入到浮动工具栏
- 通过 `FloatingToolbarActionExtension` 插件机制，任何插件都可以新增监控面板类型

---

### 10.2 Electerm 功能亮点全集

#### A. 快捷命令（Quick Commands）

`quick-commands/` 模块提供完整的命令速查板：
- 命令列表支持**标签（Labels）分类**过滤
- **关键词搜索**：同时搜索命令名和命令内容（支持 `commands[]` 数组型命令）
- **拖拽排序**：`dragstart/dragover/drop` 实现列表项重排
- **一键发送**：点击命令条目即刻发送到当前终端
- 支持批量命令（一个条目包含多条命令顺序执行）
- **导入/导出**：`QmTransport` 组件支持导入导出命令列表

**EShell 类似功能**：Scripts 功能存在但只支持单条命令，无标签/分类/搜索/拖拽排序。

---

#### B. 批量操作（Batch Op）

`batch-op/batch-op.jsx` 实现跨多服务器的批量自动化操作，CSV 格式配置：

| 列名 | 含义 |
|-----|-----|
| `host/port/username/password` | 目标服务器凭据 |
| `command` | 连接后执行的命令 |
| `localPath` | 本地文件路径（上传时） |
| `remotePath` | 远程目标路径 |
| `action` | `upload` / `download` / 仅执行命令 |
| `commandAfter` | 操作完成后执行的命令 |

- 支持 CSV 上传或手动填写
- 并发连接多台服务器，实时显示任务状态（tasks/errors/history 三个 Tab）
- 可下载执行历史记录

**EShell 现状**：无批量操作功能。

---

#### C. 主题系统（Theme）

`theme/` 模块支持完整的终端主题管理：
- 内建多套主题（颜色方案）
- 支持用户自定义终端配色（16色 + 背景/前景/光标）
- 主题可导入/导出

**EShell 现状**：有壁纸功能，但无终端配色主题切换。

---

#### D. 终端标签管理（Tabs）

`tabs/` 模块功能：
- **标签分组**：同一 session 可开多个标签
- **标签右键菜单**：关闭/克隆/移动到新窗口
- **标签搜索**：快速定位到某个标签
- **ssh+sftp 分屏视图**（`sshSftpSplitView`）：终端和 SFTP 面板并排显示

---

#### E. 远程文本编辑器（Text Editor）

`text-editor/` 模块提供网页端代码编辑器（基于 CodeMirror）：
- 从 SFTP 面板双击文本文件直接在线编辑
- 语法高亮（多语言支持）
- 保存时通过 SFTP 写回远程文件

**EShell 类似功能**：`FileEditorModal` 提供基础文本编辑，但无语法高亮。

---

#### F. SFTP 传输引擎细节

`transfer.js` 的 `fastXfer()` 高性能传输特性：
- 默认 **64 并发 chunk**（`concurrency=64`）+ **32KB chunk 大小**
- 动态调整并发数：当 `bufsize > fsize` 时逐步减少并发直到 `concurrency=1`
- 支持 **pause/resume**：通过 `pausing` 标志位，暂停时 chunk 读取用 `setTimeout` 延迟 2ms 重试
- 支持 SCP fallback（`ssh2-scp` 库）：当普通 SFTP 流不可用时切换 SCP 传输

---

#### G. 多窗口 / 多进程支持

Electerm 基于 Electron 多窗口架构：
- 支持拖出标签到新窗口
- 主进程管理所有 SSH session，渲染进程通过 WebSocket 访问
- 多个窗口可同时操作同一 session

---

#### H. SSH 配置导入导出（ssh-config）

`ssh-config/` 模块支持：
- 导入 `~/.ssh/config` 文件（OpenSSH 格式）
- 导出所有主机配置为 SSH config 格式
- 支持同步到云（Setting Sync 模块）

**EShell 现状**：无 SSH config 导入，无云同步。

---

### 10.3 Tabby 功能亮点全集

#### A. SSH Session 复用（SSHMultiplexerService）

`SSHMultiplexerService` 实现 SSH session 的引用计数复用：
```typescript
// 多个 Tab 共享同一认证的 SSH 连接
session.ref()   // 引用++
session.unref() // 引用--，归零时 destroy
```
- 同一 profile 的多个 Tab 复用同一 SSH 连接，**只需认证一次**
- Tab 关闭时 `unref()`，所有 Tab 关闭时才真正断开 SSH

---

#### B. 完整的认证链（SSHSession._handleAuth）

认证方法按优先级顺序尝试：
1. `none`（无认证，部分服务器支持）
2. `publickey`（RSA/ECDSA/Ed25519，从文件或 Agent 读取）
3. `agent`（SSH Agent，支持 OpenSSH Agent / Pageant / Unix Socket）
4. `keyboard-interactive`（2FA，弹出交互式提示框，支持多轮问答）
5. `password`（密码，支持"记住密码"）
6. `hostbased`（基于主机的认证）

特别设计：
- **`remainingMethods`** 服务器返回允许的认证方式，按此过滤客户端支持的认证链
- 密码管理服务（`PasswordStorageService`）持久化已认证的密码，下次连接自动填入
- Agent 认证支持**指定公钥**（`publicKey` 参数），只尝试匹配的 Agent 身份

---

#### C. 多种传输方式（SSHSession.start）

```typescript
// 按配置选择传输通道
if (proxyCommand)      → russh.SshTransport.newCommand()
if (jumpChannel)       → russh.SshTransport.newSshChannel()
if (socksProxyHost)    → russh.SshTransport.newSocksProxy()
if (httpProxyHost)     → russh.SshTransport.newHttpProxy()
else                   → russh.SshTransport.newSocket()
```

支持：直连、ProxyCommand、Jump Host、SOCKS5 代理、HTTP 代理。

---

#### D. PTYDataQueue 流控

```typescript
class PTYDataQueue {
    maxBufferedLength = 2 ** 22  // 4MB 最大缓冲
    drainInterval = 50           // 50ms 最快推送间隔
}
```
- 累积 PTY 输出，最快每 50ms 推送一次给渲染层
- 若积压超过 4MB 直接强制推送，防止内存无限增长
- 避免高频输出（如 `cat /dev/urandom`）导致前端卡顿

---

#### E. 上传原子性（SFTPSession.upload）

```typescript
async upload(path, transfer) {
    const tempPath = path + '.tabby-upload'  // 写入临时文件
    // ... write chunks ...
    await this.unlink(path)                  // 删除旧文件
    await this.rename(tempPath, path)        // 原子替换
    // 失败时清理临时文件
}
```

保证上传中断不会留下半损坏的文件。

---

#### F. 算法可配置（SSHAlgorithmType）

前端可以为每个主机独立配置：
- `cipher`：对称加密算法（AES-128/256-CTR/GCM 等）
- `kex`：密钥交换算法（curve25519、diffie-hellman 等）
- `hmac`：HMAC 算法
- `hostkey`：主机密钥类型（rsa/ecdsa/ed25519）
- `compression`：压缩（zlib/none）

**EShell 现状**：无算法配置，依赖 ssh2 crate 默认协商结果，当服务器只支持老算法时无法连接。

---

#### G. Known Hosts 管理（SSHKnownHostsService）

- `~/.ssh/known_hosts` 格式的主机密钥存储
- 连接时与已知 hosts 比对，不匹配则弹出确认框（`HostKeyPromptModalComponent`）
- 支持 "Trust and Remember" / "Trust Once" / "Reject" 三种决策
- 可在设置中查看和删除所有已信任的主机密钥

---

#### H. WinSCP 集成（SSHService.launchWinSCP）

在 Windows 上可以一键启动 WinSCP（使用当前 session 的凭据）：
- 自动构造 `scp://user:pass@host:port/cwd` URI
- 支持私钥转换为 PuTTY 格式（`.ppk`）
- 支持跳板机参数传递（`x-tunnel` URI 参数）
- 热键 `launch-winscp` 直接触发

---

#### I. X11 转发（SSHSession）

```typescript
this.ssh.x11ChannelOpen$.subscribe(async event => {
    const displaySpec = config.store.ssh.x11Display || process.env.DISPLAY || 'localhost:0'
    const x11Stream = await socket.connect(displaySpec)
    // 双向桥接 SSH channel 和本地 X11 server
})
```

完整实现 X11 转发，连接本地 X server 并桥接 SSH 通道。

---

#### J. 端口转发 UI（SSHPortForwardingModalComponent）

- 可视化管理当前 session 的所有端口转发规则
- 支持动态添加/删除（不需要重新连接）
- 按类型分组：Local Forward / Remote Forward / Dynamic（SOCKS）

---

### 10.4 三项目共同亮点（EShell 均缺失）

| 功能 | Termora | Electerm | Tabby | EShell |
|-----|---------|----------|-------|--------|
| SSH Agent 转发 | ✅ | ✅ | ✅ | ❌ |
| 跳板机 / Jump Host | ✅ | ✅ | ✅ | ❌ |
| 代理（SOCKS/HTTP） | ✅ | ✅ | ✅ | ❌ |
| 端口转发 | ✅ | ❌ | ✅ | ❌ |
| 登录脚本 / 自动发送 | ✅ | ✅（快捷命令） | ✅（LoginScript） | ❌（Scripts 存在但不自动） |
| 主机 Known Hosts 管理 | ✅ | ✅ | ✅ | ✅ 已实现 |
| keyboard-interactive 2FA | ✅ | ✅ | ✅ | ❌ |
| 终端主题/配色方案 | ✅ | ✅ | ✅ | ❌ |
| 关键词高亮 | ✅ | ✅ | ✅ | ❌ |
| 上传原子性（tmp+rename） | ❌ | ❌ | ✅ | ❌ |
| 传输文件冲突确认对话框 | ✅ | ✅ | ❌ | ❌ |
| 文件修改时间保留 | ✅ | ✅ | ❌ | ❌ |
| 快捷命令面板 | ❌ | ✅ | ❌ | ⚠️ Scripts 基础版 |
| 批量多服务器操作 | ❌ | ✅ | ❌ | ❌ |
| SSH 算法可配置 | ❌ | ✅ | ✅ | ❌ |
| SSH config 导入 | ❌ | ✅ | ✅ | ❌ |
| 多协议（Telnet/Serial/RDP/VNC） | ✅ | ✅ | ✅ | ❌ |
| PTY 流量节流 | ❌ | ❌ | ✅（PTYDataQueue） | ⚠️ 固定 8ms sleep |
| 传输暂停/恢复 | ❌ | ✅ | ❌ | ❌ |
| 在线代码编辑器（语法高亮） | ❌ | ✅ | ❌ | ⚠️ 基础文本编辑 |
| 传输速度显示 | ✅ | ✅ | ✅ | ❌ |
| GPU 监控（nvidia-smi） | ✅ | ❌ | ❌ | ❌ |
| 插件/扩展系统 | ✅ | ✅ | ✅ | ❌ |

---

*注：本分析基于源码阅读，不涉及任何代码复制。如需参考具体实现，应先确认各项目许可证兼容性。*
