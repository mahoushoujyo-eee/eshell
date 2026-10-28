# 独立 MCP Server 与 CLI 指南

本文记录 eShell 的两个**脱离桌面应用**运行的入口：

- `eshell-mcp` —— 一个标准 MCP server（stdio 传输），让 Claude Code / Codex / Cursor 等任意 MCP 客户端直接操作 eShell 管理的服务器；
- `eshell-cli` —— 一个命令行工具，让偏好 Bash 的 agent（或人）执行同样的操作。

两者与桌面应用共用**同一套 MCP 核心**（`src-tauri/src/domain/agent/service/mcp_server.rs`），因此工具名、参数 schema、返回结构完全一致，行为不会漂移。

相关文档：

- [ACP Agent 集成指南](acp_agent.md) —— 桌面应用内嵌的 MCP bridge（loopback HTTP）如何注入 ACP agent 会话
- [eShell 配置指南](../../../../skills/eshell-config/SKILL.md) —— `.eshell-data/` 目录结构与配置文件格式
- [后端架构](../architecture/backend_architecture.md)

---

## 1. 为什么需要独立入口

桌面应用内的 MCP bridge（`domain/agent/service/mcp_bridge.rs`）有两个硬约束：

1. **必须先启动 eShell 应用**——它跑在 Tauri 的 `setup` 钩子里，进程不活着，端点就不存在；
2. **只能操作用户已打开的会话**——所有工具的 `sessionId` 指的是 GUI 里的终端标签页，没有标签页就没有可操作的服务器。

独立入口把这两条都拆掉了：进程自己读配置、自己建 SSH 连接、自己管会话。**eShell 桌面应用不用开着。**

---

## 2. 构建

两个二进制都在 `src-tauri` 这个 crate 里：

```bash
cd src-tauri
cargo build --release --bins
```

产物：

| 二进制 | 路径 | 说明 |
| --- | --- | --- |
| `eshell-cli` | `target/release/eshell-cli.exe` | 命令行 |
| `eshell-mcp` | `target/release/eshell-mcp.exe` | MCP server |

两个都是单文件、可以直接拷走使用。`eshell-cli --help` 和 `eshell-mcp --help` 都能看到完整的参数说明。

> 二进制仍链接 `tauri`（与桌面应用同 crate），因此在 Linux 上编译需要 `webkit2gtk` 等 Tauri 系统依赖。**运行**它们不需要 GUI，也不需要 WebView。

---

## 3. 配置文件位置

两个工具都读 `.eshell-data/` 目录，解析优先级从高到低：

1. `--data-dir <DIR>` 命令行参数；
2. `ESHELL_DATA_DIR` 环境变量；
3. **当前工作目录下的 `.eshell-data/`**（存在才用）——桌面应用开发模式正是这个布局，所以从同一个目录跑工具能看到同一批服务器；
4. 用户级全局目录：
   - Windows：`%APPDATA%\eshell\.eshell-data`
   - macOS：`~/Library/Application Support/eshell/.eshell-data`
   - Linux：`$XDG_DATA_HOME/eshell/.eshell-data`（未设则 `~/.local/share/eshell/.eshell-data`）

随时可以确认解析结果：

```bash
eshell-cli config
eshell-cli config --json
```

### 3.1 与桌面应用的数据目录不是同一个地方

**这一点最容易踩。** 桌面应用用的是**它自己的进程工作目录**下的 `.eshell-data`（见 `src-tauri/src/lib.rs` 的 `resolve_storage_root()`）：

- 开发模式（`npm run tauri -- dev`）→ `src-tauri/.eshell-data`
- 安装后的应用 → 取决于应用启动时的工作目录

而上面第 4 档兜底（用户级目录 `%APPDATA%\eshell\.eshell-data`）**和桌面应用用的位置对不上**。所以想让 CLI 看到桌面应用里那批服务器，必须显式指过去：

```bash
eshell-cli --data-dir "D:/path/to/.eshell-data" profiles
# 或者
export ESHELL_DATA_DIR="D:/path/to/.eshell-data"
```

反过来，CLI 在别的目录跑、桌面应用在另一个目录跑时，两边各读各的 `.eshell-data`，互不可见——**改配置前先确认两边指的是同一份**。

---

## 4. `eshell-cli`

### 4.1 命令一览

| 命令 | 作用 |
| --- | --- |
| `profiles` | 列出已配置的 SSH 服务器（不含凭据） |
| `config` | 显示配置目录与 profile 数量 |
| `exec <target> -- <command>` | 在服务器上执行一条命令 |
| `status <target>` | 拉取 CPU / 内存 / 磁盘 / 网络 / 进程实时指标 |
| `ls <target> <path>` | 列出远端目录 |
| `cat <target> <path>` | 读取远端文件 |
| `write <target> <path>` | 写入远端文件（`--content` / `--file` / 标准输入） |
| `mcp` | 在 stdio 上启动 MCP server（等价于 `eshell-mcp`） |

`<target>` 是 **SSH profile 的名字或 id**（名字大小写不敏感，也支持无歧义的前缀），不是会话 id。

### 4.2 用法示例

```bash
# 看有哪些服务器
eshell-cli profiles

# 在 prod 上执行命令（stdout 直接透传，退出码透传）
eshell-cli exec prod -- "docker ps"
eshell-cli exec prod -- "df -h /"

# 指标
eshell-cli status prod

# 文件操作
eshell-cli ls prod /var/log
eshell-cli cat prod /etc/hosts
echo "hello" | eshell-cli write prod /tmp/hello.txt
eshell-cli write prod /tmp/hello.txt --content "hello"

# 机器可读输出
eshell-cli exec prod --json -- "docker ps"
```

### 4.3 退出码

沿用 OpenSSH 的约定，方便脚本与 agent 判断：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1..254` | **远端命令自身的退出码**（`exec` 时透传） |
| `2` | 命令行用法错误 |
| `255` | eShell 自身出错（连不上、鉴权失败、文件不存在……） |

### 4.4 在 Git Bash / MSYS2 里传远端绝对路径

Git Bash 会把传给原生 Windows 程序的 `/` 之类的参数改写成 Windows 路径（MSYS 的路径转换）。结果是 `eshell-cli ls prod /var/log` 实际收到的是 `C:/Program Files/Git/var/log` —— 列出来的是 Git 安装目录，不是远端。

在 Git Bash / MSYS2 里关掉转换即可：

```bash
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

eshell-cli ls prod /var/log
eshell-cli cat prod /etc/hosts
```

PowerShell 和 cmd.exe 没有这个问题。

---

## 5. `eshell-mcp`

### 5.1 启动

```bash
eshell-mcp                                  # stdio（默认，MCP 客户端用这个）
eshell-mcp --data-dir D:/eshell-data        # 指定配置目录
eshell-mcp --strict-host-key                # 拒绝未知/变更的主机密钥
eshell-mcp --http 8765                      # 改成 loopback HTTP
```

stdio 模式下 **stdout 只有 JSON-RPC 消息**，所有日志走 stderr——这是 MCP stdio 传输的硬性要求。

HTTP 模式与桌面应用的 bridge 同契约：`POST http://127.0.0.1:<port>/mcp`，请求头 `Authorization: Bearer <token>`。token 未指定时随机生成，会打印到 stderr。

### 5.2 接入 MCP 客户端

**Claude Code**（`claude mcp add`）：

```bash
claude mcp add eshell -- "D:/cctest/eshell/src-tauri/target/release/eshell-mcp.exe"
```

或直接写配置文件 `~/.claude.json` / `.mcp.json`：

```json
{
  "mcpServers": {
    "eshell": {
      "command": "D:\\cctest\\eshell\\src-tauri\\target\\release\\eshell-mcp.exe",
      "args": ["--data-dir", "D:\\cctest\\eshell\\src-tauri\\.eshell-data"]
    }
  }
}
```

> `--data-dir` 指向的必须是**桌面应用用的那一份** `.eshell-data`（见 §3.1），否则 MCP server 会连到另一份空配置，agent 一个 profile 都看不到。
>
> MCP 客户端启动 server 时工作目录通常不是你的项目目录，所以别指望第 3 档（当前目录下的 `.eshell-data`）能命中——**客户端配置里一定要显式写 `--data-dir`**。

**Codex / Cursor / 通用客户端**用同一份 JSON——`mcpServers` 是事实标准：

```json
{
  "mcpServers": {
    "eshell": {
      "command": "/usr/local/bin/eshell-mcp"
    }
  }
}
```

**HTTP 模式**（远程 agent、多个客户端共用一个长驻服务）：

```json
{
  "mcpServers": {
    "eshell": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

---

## 6. 工具面

独立 server 与桌面应用暴露**同样的工具集合**。默认状态（两个内置插件都启用）是 **9 个**：

| 工具 | 参数 | 来源 |
| --- | --- | --- |
| `read_agent_context` | — | 核心 |
| `reload_config` | `file?` | 核心 |
| `list_ssh_profiles` | — | 核心 |
| `list_shell_sessions` | — | 核心 |
| `execute_command` | `sessionId`, `command` | 核心 |
| `read_remote_file` | `sessionId`, `path` | SFTP 插件 |
| `write_remote_file` | `sessionId`, `path`, `content` | SFTP 插件 |
| `list_remote_dir` | `sessionId`, `path` | SFTP 插件 |
| `get_server_status` | `sessionId` | 监控插件 |

> **工具数不是固定的 9 个。** 插件工具跟着 `.eshell-data/extensions/` 里持久化的启用状态走：在桌面应用里停用 SFTP 扩展，独立 server 就只暴露 5 个核心工具，`list_remote_dir` 等会直接报 "unknown tool"。这和桌面应用内的 bridge 行为一致——停用的插件不贡献工具。

### 6.1 `sessionId` 的两种含义

| 运行方式 | `sessionId` 含义 |
| --- | --- |
| 桌面应用内的 bridge | 用户打开的终端标签页 id（`list_shell_sessions` 返回） |
| `eshell-mcp` / `eshell-cli` | **SSH profile 的名字或 id**——进程按需建连，连接被缓存复用 |

独立 server 里 `sessionId` 参数的描述也会相应改写成「session id，或 SSH profile 名/id」。**工具名、schema 结构、返回字段都不变**，只有这一个参数的取值范围放宽了。

于是 agent 的典型流程变成：

```text
list_ssh_profiles        →  拿到 {id, name, host, port, username}
execute_command(sessionId="prod", command="docker ps")
```

不需要先 `open_session`，也不需要 `list_shell_sessions` 拿 id。

### 6.2 会话生命周期

- profile → 连接是**按需建立并缓存**的：第一次用到时握手，之后复用；
- 缓存的会话保留工作目录，`cd` 之后的后续命令仍在该目录执行（与 GUI 标签页一致）；
- 连接断了会在下次调用时自动重连；
- 进程退出时连接随之关闭；独立 server 是长驻进程，连接会一直保留。

### 6.3 `initialize` 的 instructions 按模式区分

`initialize` 返回的 `instructions` 是 agent 读到的第一段指引，两种模式的文案不同：

| 模式 | 指引内容 |
| --- | --- |
| 桌面应用内的 bridge | 先 `list_shell_sessions`，在用户已打开的终端标签页里操作 |
| `eshell-mcp` / `eshell-cli` | 先 `list_ssh_profiles`，把 profile 名当 `sessionId` 用；不需要终端标签页 |

> 独立模式下 `list_shell_sessions` 在没有任何调用之前返回空数组——所以独立模式的 instructions 不能叫 agent 先去找标签页，那条路走不通。

---

## 7. Host Key 策略

桌面应用遇到未知主机密钥时会弹审批卡片让人点「信任」。独立进程没有人可问，所以策略在启动时定死：

| 模式 | 未知主机 | 主机密钥变更 |
| --- | --- | --- |
| 默认（`AcceptAny`） | 自动信任，写入 `known_hosts.json`，stderr 打印一行告知 | **自动覆盖旧指纹**，stderr 打印 `WARNING` |
| `--strict-host-key` | 拒绝，要求手工写入 `known_hosts.json` | 拒绝 |

> ⚠️ 「密钥变更也自动覆盖」意味着**放弃中间人检测**：如果一台服务器的主机密钥真的被换掉了（重装系统、换了机器、或被劫持），工具会默默接受新密钥。变更时 stderr 会打一条显眼的 `WARNING`，但不会阻断操作。如果你的环境在意这一点，请加 `--strict-host-key`。

---

## 8. 与桌面应用的区别

| | 桌面应用内的 bridge | `eshell-mcp` / `eshell-cli` |
| --- | --- | --- |
| 传输 | loopback HTTP + 随机 bearer token | stdio（默认）/ loopback HTTP |
| 生命周期 | 跟随 GUI 进程 | 独立进程 |
| 会话来源 | 用户打开的标签页 | 按 profile 自动建连 |
| 危险操作 | 触发 agent 侧的权限审批卡片 | 由客户端自己的权限机制决定 |
| 认证方式 | 密码、私钥 | 密码、私钥（keyboard-interactive 需要 GUI，**不支持**） |

**并发注意**：独立进程与桌面应用是两个进程，各自有独立的会话与连接，互不感知；但它们会读写同一份 `.eshell-data/*.json`。同时修改配置文件时，后写的一方会覆盖先写的一方——改配置前先关掉另一个。

---

## 9. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/domain/agent/service/mcp_server.rs` | 传输无关的 MCP 核心：工具注册表、`sessionId` 解析层、JSON-RPC 分发 |
| `src-tauri/src/domain/agent/service/mcp_bridge.rs` | 桌面应用用的 HTTP 传输（跑在同一个核心上） |
| `src-tauri/src/cli/mod.rs` | 两个独立入口的启动流程 |
| `src-tauri/src/cli/args.rs` | 两个二进制的命令行参数（clap derive） |
| `src-tauri/src/cli/runtime.rs` | 独立运行时：状态容器 + 按 profile 缓存的会话 |
| `src-tauri/src/cli/hostkey.rs` | host key 策略与重试 |
| `src-tauri/src/cli/data_dir.rs` | 配置目录解析 |
| `src-tauri/src/cli/commands.rs` | `eshell-cli` 的子命令实现 |
| `src-tauri/src/cli/mcp_stdio.rs` | stdio 传输 |
| `src-tauri/src/bin/eshell-cli.rs`、`eshell-mcp.rs` | 二进制入口 |
