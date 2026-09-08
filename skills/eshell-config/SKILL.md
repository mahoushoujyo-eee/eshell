---
name: eshell-config
description: >-
  Edit eShell's SSH, ACP, and Ops Agent config files and understand .eshell-data.
  Use when the user asks to add/change an SSH server profile, adjust agent login
  or spawn settings, add an ACP agent, explain what a .eshell-data file does, or
  tune connection/agent behavior via one of the JSON config files. Covers the
  exact file paths, schema keys, wire-format values, and gotchas (Windows cmd
  shim, mcpServers format, eshellTools flag, authType values, jumpHostId,
  AGENTS.md bundle). Also use when the user must restart after a config change,
  or to explain that config edits only take effect on the next launch / agent
  start.
---

# eShell 配置文件指南

本 skill 是**改 eShell 配置 / 理解 `.eshell-data/` 的权威参考**。

所有配置都是 JSON，存放在应用运行目录下的 `.eshell-data/`（dev 模式为 `src-tauri/.eshell-data/`；打包运行跟随工作目录）。

⚠️ **配置不是在运行中热加载的**：SSH 配置在打开连接时读取，ACP 配置在 agent `start`（spawn/handshake）时读取。**改完配置后，必须重启应用，或重启/重新启动对应的 agent 或（对 SSH）重新打开连接，改动才会生效。已完成运行的 agent / 已打开的 shell 会话不会重读配置。** 完成配置修改后在回复里要明确告诉用户需要重启。

读取配置的 Tauri 命令：`list_ssh_configs` / `save_ssh_config` / `delete_ssh_config` / `list_ai_import_sources`；ACP 侧是 `acp_agent_list`。**优先用命令改，不要直接手写文件**——文件写入需经 `write_json_pretty` 且 SSH 字段有校验（`validate_ssh_credentials`）。

## 0. `.eshell-data/` 目录全览

以下是每项的实际用途与格式（已逐一核对源码与真实文件）：

| 路径 | 类型 | 用途 / 格式 | 谁在写 |
| --- | --- | --- | --- |
| `agent/AGENTS.md` | 文件 | **全局 agent 上下文**。可编辑 AGENTS.md（`save_agent_context(None, ...)` 写这里），无 ACP 自动注入，供 agent 自行引用 | Agent 配置 |
| `ssh_configs.json` | 文件 | `SshConfig[]` 数组（见 §1） | SSH 配置管理 |
| `known_hosts.json` | 文件 | **SSH host key 信任指纹**：`[{host, port, keyType, fingerprint, createdAt, updatedAt}]`，连接时校验，新主机首次连接走 `trust_ssh_host_key` 确认后写入 | SSH 连接层 |
| `acp_agents.json` | 文件 | `{agents:[AcpAgentSpawnConfig]}`（见 §2） | ACP 配置管理 |
| `acp_sessions/` | 目录 | **ACP 历史会话**，每会话一个 JSON：`{id, agentId, agentName, title, createdAt, updatedAt, transcript: [...]

}`（transcript 为面板条目原样，图片只留 mimeType）。`acp_history_*` 命令读写 | ACP 面板 |
| `agent/<serverId>.md` | 文件 | **服务器级 agent 上下文**，每台服务器一个 `.md`。文件名 = SSH profile 的 `id`。`save_agent_context(Some(server_id), ...)` 写这里 | Agent 配置 |
| `agent/skills/eshell-config/` | 目录 | **随应用打包的 eshell-config 技能**，首启 seed 到这里（已存在则不动），供 agent/用户修改 | Agent 配置 |
| `ops_agent_conversation_list.json` | 文件 | Ops Agent 会话列表元数据：`{conversations:[], activeConversationId:null, pendingActions:[]}` | Ops Agent |
| `ops_agent_conversations/` | 目录 | Ops Agent **会话正文**（每会话一个文件，含消息流） | Ops Agent |
| `ops_agent_runs/` | 目录 | Ops Agent **run 记录**（每次 run 的追踪/状态） | Ops Agent |
| `ops_agent_attachments/` | 目录 | Ops Agent **附件**（聊天图片等，detached 持久化） | Ops Agent |
| `ops_agent_debug.log` | 文件 | Ops Agent 调试日志（追加写） | Ops Agent |
| `server_ops_debug.log` | 文件 | **SSH/PTY/SFTP 调试日志**（追加写；`append_server_ops_debug_log`），含 `pty.worker.keepalive_failed` / `pty.worker.disconnected` 等 | server_ops |
| `scripts.json` | 文件 | `ScriptDefinition[]`，命令草稿/脚本中心 | 脚本管理 |
| `ai_profiles.json` | 文件 | **旧 AI 体系模型配置**：`{profiles:[{apiType, baseUrl, apiKey, model, systemPrompt,...}], activeProfileId}` | AI 配置 |
| `ai_config.json` | 文件 | **旧 AI 体系全局配置**（`LEGACY_AI_CONFIG_FILE`），approval/agent 模式等 | AI 配置 |

⚠️ 注意点：

- `agent/<serverId>.md` 的文件名（不含 `.md`）**必须是 SSH profile 的 `id`**，且要求 `is_safe_path_segment`（不含路径分隔符）。如果删掉对应 SSH profile，文件会残留。
- `ai_profiles.json` / `ai_config.json` 属于被 ACP 取代的旧助手，**已无面板入口**；工具栏的「Agent 配置」只编辑 AGENTS.md（全局 + 每台服务器）。
- 上述文件多数由命令写入；**调试日志（`*_debug.log`）可安全忽略/删除**，会自动重建。

## 1. SSH 配置文件 —— `ssh_configs.json`

顶层是 `SshConfig[]` 数组。前后端 wire 格式统一为 **camelCase**（结构体 `#[serde(rename_all = "camelCase")]`）。

每个条目：

| key | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 生成 | UUID，`save` 时省略则新建 |
| `name` | string | ✅ | 展示名，非空 |
| `host` | string | ✅ | 主机名/IP，非空 |
| `port` | u16 | ✅ | 1–65535，0 非法 |
| `username` | string | ✅ | 登录用户，非空 |
| `authType` | enum | ✅ | `"password"` / `"privateKey"` / `"keyboardInteractive"`（**小写驼峰**） |
| `password` | string | 条件 | Password 必填；PrivateKey 且 `usePasswordFallback` 必填；其余可空 |
| `privateKeyPath` | string | 条件 | PrivateKey 必填 |
| `privateKeyPassphrase` | string | 单选 | 私钥密码（可空） |
| `usePasswordFallback` | bool | 单选 | 私钥认证失败是否回退密码；回退时 `password` 必填 |
| `jumpHostId` | string? | 单选 | 其他 profile 的 id；**同时指向自身则忽略**；指向不存在 id 也忽略 |
| `description` | string | 单选 | `save` 时缺省为 `""` |
| `createdAt` / `updatedAt` | string | 自动 | ISO-8601，服务端维护 |

⚠️ **enum 序列化（易错）**：`SshAuthType` 变体 `Password`/`PrivateKey`/`KeyboardInteractive` 落在 JSON 是 **小写驼峰** `"password"`/`"privateKey"`/`"keyboardInteractive"`（受结构体 `rename_all = "camelCase"` 影响）。实测文件即 `"authType": "password"`。**不存在 PascalCase 落盘**。

### 常见任务

- **加一台服务器**：`save_ssh_config`（不带 `id`）→ 返回含 `id` 的新条目。
- **改凭据**：用 `save_ssh_config` 传完整条目（带 `id` 即更新）。后台校验会拦空密码，禁止绕过校验直改文件。
- **跳板机**：B 服务器 `jumpHostId` 指向 A 的 `id`。链式（A→B→C）仅支持单跳，`resolve_jump_host_id` 不会递归。
- **host key 信任**：新主机首次连接触发 `SshHostKeyTrustChallenge`，走 `trust_ssh_host_key` 确认后写 `known_hosts.json`——**不属于配置文件字段**，别手动加。
- **其他文件勿动**：`scripts.json`（命令草稿）、`ai_profiles.json`/`ai_config.json`（旧 AI 体系）。

## 2. ACP 配置文件 —— `acp_agents.json`

顶层是 `{ "agents": [ AcpAgentSpawnConfig ] }` 对象（**不是数组**）：

| key | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 唯一标识，面板下拉 value |
| `name` | string | ✅ | 展示名 |
| `command` | string | ✅ | **可执行文件或解释器** |
| `args` | string[] | ✅ | 传给 command 的参数 |
| `env` | object | 单选 | 环境变量（如 `{"CODEX_API_KEY": "sk-..."}`）；OAuth 登录态时可不填 |
| `cwd` | string? | 单选 | 会话工作目录（`session/new` 的 cwd），缺省 = 应用当前目录 |
| `mcpServers` | array | 单选 | 额外 MCP server（格式见下）。**不要配 eShell 自己的**，见 `eshellTools` |
| `eshellTools` | bool | 单选 | 默认 **true**：自动注入 eShell 内置 MCP（SSH/服务器工具集）。`false` 关闭 |

默认配置在 `default_agents()`（Rust）；文件不存在时首次 `acp_agent_list` 自动生成。

### 新增 agent 的标准姿势

Windows 下 npm 包必须走 cmd shim：`"command": "cmd"`、`args` 以 `"/c"` 开头：

```json
{
  "id": "claude",
  "name": "Claude Code",
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@agentclientprotocol/claude-agent-acp"],
  "env": {}
}
```

### mcpServers 的 wire 格式

`McpServer` 是 tagged enum，`type` 判别字段为 `"http"`/`"sse"`/`"stdio"`：

- **stdio**：`{"type":"stdio","name":"...","command":"...","args":[...],"env":[{"name":"N","value":"V"}]}`
- **http**：`{"type":"http","name":"...","url":"https://...","headers":[{"name":"Authorization","value":"Bearer ..."}]}`
- **sse**：同 http，`type` 为 `"sse"`

eShell 自己注入的是 **http** 类型 `http://127.0.0.1:{port}/mcp` + `Authorization: Bearer {token}`。**别手动配它**——token 每次运行都变，由 `eshellTools` 自动处理。

## 3. 服务器操作规范（eShell MCP 工具）

eShell 内置 MCP bridge（loopback + 每运行随机 Bearer token），只暴露以下工具，agent 在**用户已打开的会话**内操作服务器。凭据不经过 agent；危险操作触发审批卡片。

工具（参数需 `sessionId`，来自 `list_shell_sessions`）：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_ssh_profiles` | 无 | `{profiles:[{id,name,host,port,username}]}` |
| `list_shell_sessions` | 无 | `{sessions:[{sessionId,profile,configId,currentDir,updatedAt}]}` |
| `execute_command` | `sessionId`, `command` | `{stdout,stderr,exitCode,currentDir,durationMs}` |
| `read_remote_file` | `sessionId`, `path` | 文件内容（SftpFileContent） |
| `write_remote_file` | `sessionId`, `path`, `content` | `{written: path}` |
| `list_remote_dir` | `sessionId`, `path` | 目录列表（SftpListResponse） |
| `get_server_status` | `sessionId` | CPU/内存/磁盘/网络/进程 |

规范：

1. **`execute_command` 在会话 cwd 下执行**，`cd` 会更新会话 cwd（持久到服务端）。改目录用 `cd`，后续命令与面板侧保持一致。
2. **`write_remote_file` 覆盖/创建**；先 `read_remote_file` 确认再写。
3. **`list_shell_sessions` 是入口**：任何服务器操作前先调它拿 `sessionId`；没有会话时提示用户先开 webshell，**不要尝试用 SSH profile 直接建新连接**（工具只接 `sessionId`）。
4. **输出上限 60k 字符**（超出截断），长输出分页查询。
5. 这些调用触发 `session/request_permission` → 面板审批卡片。**不要绕过审批**。
6. `get_server_status` 是快照（实况拉取），非流式。

## 4. 生效规则与错误处理

- **生效规则（核心）**：所有配置在读取点（连接建立 / agent start / 会话创建）一次性读入，**没有运行中热加载**。改完必须重启才能生效：
  - `acp_agents.json` → 重启应用，或停止并重新启动该 agent；
  - `ssh_configs.json` → 重启应用，或重新打开对应 shell 会话；
  - `known_hosts.json` → 常由 `trust_ssh_host_key` 自动维护，勿手改。
  完成修改后在回复里**明确告知用户需要重启**，不要声称"改完即生效"。
- 校验失败返回英文 `AppError::Validation`/`NotFound` 消息，逐字段修复（如 Password 认证缺 `password`、PrivateKey 缺 `privateKeyPath`）。
- agent 已启动时改 `acp_agents.json`，正在运行的实例不会重读；需先 `acp_agent_stop` 再重新 start。已打开的 shell 会话同理，需先 close 再 open。

补充参考：[ACP Agent 集成指南](docs/acp_agent.md)（本 skill 目录内附有副本；讲 agent 接入/命令/MCP 工具，与配置指导互为补充）。
