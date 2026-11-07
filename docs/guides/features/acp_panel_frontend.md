# ACP 面板前端指南（UI 交接文档）

本文面向**接手 ACP 聊天面板 UI 的开发者**：组件结构、状态契约、交互清单、样式约定，以及已知的 UI 待优化项。协议与后端实现见 [ACP Agent 指南](acp_agent.md)，会话模型的重构设计见 [ACP 会话模型方案](../../plans/acp-session-model.md)。

核心原则：**视图层是纯渲染**。所有状态与副作用都在 `useAcpAgent` hook 里；改 UI 不需要动 hook 和 Rust，只要不破坏下述契约。

## 1. 文件清单

| 文件 | 职责 |
| --- | --- |
| `src/components/panels/AcpAgentPanel.jsx` | 面板外壳：tab 条、上下文条、正文分支、composer |
| `src/components/panels/acp/AcpSessionTabs.jsx` | 会话 tab 条：角标、`+`（新建会话 / 选 agent）、历史入口、`⋮`（停止进程） |
| `src/components/panels/acp/AcpAgentMenu.jsx` | agent 选择列表；tab 条的 `+` 与历史面板里项目行的 `+` 共用 |
| `src/components/panels/acp/AcpPathPicker.jsx` | 启动页的路径下拉：默认目录 / 已注册项目 / 新建项目 |
| `src/components/panels/acp/AcpTranscript.jsx` | 会话正文渲染：Markdown、思考、工具卡、权限卡、通知行、计划卡、登录卡 |
| `src/components/panels/acp/AcpHistoryPanel.jsx` | 历史会话浮层：按项目分组、打开成 tab、删除、新建项目 |
| `src/components/panels/acp/AcpPickers.jsx` | 模式胶囊 + 会话设置双栏菜单 + `MenuLayer`/`MenuPanel` 定位层 |
| `src/components/panels/acp/AcpNoticeRow.jsx` | 通知行；`noticeCopy()` 负责 code→文案映射（`AcpNoticeRow.test.js` 覆盖） |
| `src/components/ai/AcpEnvWarningCard.jsx` | 缺 Node.js 时的常驻提示卡 |
| `src/components/ai/AcpAgentLogo.jsx` | 单个 Agent 的品牌标识（未识别品牌回退中性图标） |
| `src/lib/acpAgentBrands.js` | 品牌注册表 + 匹配逻辑（`acpAgentBrands.test.js` 覆盖） |
| `src/lib/acpConfigOptions.js` | 会话配置项（模型/思考强度/…）的过滤、排序、分组、当前值取名（`acpConfigOptions.test.js` 覆盖） |
| `src/hooks/useAcpAgent.js` | **多会话状态机**：事件路由、每会话 transcript、历史持久化、全部 action |
| `src/components/app/AppAiDock.jsx` | 右侧 dock 容器：宽度/拖拽/显隐动画 |
| `src/App.jsx` | 创建 hook 实例；dock 宽度状态；Esc 关闭；面板打开时刷新 agent 列表并探测 Node 环境 |
| `src/components/app/AppWorkspace.jsx` | 标题栏 AI 按钮 ↔ `showAiPanel`；忙碌指示 = `acp.anyTurnActive` |
| `src/lib/tauri-api.js` | `acp*` 命令封装（全部后端调用入口） |
| `src/lib/i18n.js` | 文案（英文原文为 key，中文在 `zhMessages`，缺失时回退英文） |
| `scripts/acp-probe.mjs` | 探针：单个 agent 握手 + `session/new` 返回，用于确认某 agent advertise 什么 |
| `scripts/acp-concurrency-probe.mjs` | 探针：同一进程两个会话能否并发跑 turn、`session/close` 是否生效 |

复用组件：Markdown 渲染用 `ReactMarkdown` + `MARKDOWN_COMPONENTS`（来自 `ai-assistant/aiAssistantUtils.jsx`，样式类 `.ai-markdown` 在全局 CSS）。图标一律 `lucide-react`。

## 2. 状态契约（hook 返回值）

### 多会话表面（面板主用）

```
conversations     [SessionState]   按创建顺序；一个 tab 一项（见下）
activeKey         string | null    当前显示的会话
activeConversation SessionState | null
openSession({ agentId?, project?, resume? }) → key|null
closeSession(key)                 结束该会话并移除 tab；最后一个 tab 才回收进程
stopAgent(agentId)                停止整个 agent 进程（该 agent 所有会话 → ended）
anyTurnActive     bool            任一会话在跑（标题栏/状态栏用）
```

```
SessionState = {
  key, agentId, agentName,
  sessionId,        null | agent 返回的 id（starting 阶段为 null）
  phase,            "starting" | "auth" | "authenticating" | "ready" | "ended"
  cwd, projectId,
  transcript, plan, commands, configOptions, usage, modes,
  authMethods, agentInfo, capabilities,
  turnActive, unread, ended, failed,
  draft: { text, attachments, shellContext },
  title, createdAt,
}
```

### 单会话派生表面（正文与 composer 用）

面板只读这些，它们都镜像 `activeConversation`：

```
phase             activeConversation?.phase ?? "idle"
session           null | { agentId, agentName, id, modes, agentInfo, capabilities, projectId, cwd, createdAt }
                  capabilities: { loadSession, promptImage, closeSession }
transcript        条目数组（见下）
plan              null | [{content, priority, status}]
commands          [{name, description, inputHint?}]
configOptions     [{id, name, description?, category?, type, currentValue, options?}]
usage             null | {used, size}
turnActive        当前会话是否在跑
draft             { text, attachments, shellContext }
standaloneNotices 无会话可挂时的通知（项目注册失败等）
shellContext      当前会话草稿里的终端选中内容（≤4000 字符）
```

Actions（全部作用于**当前会话**，`history` 相关除外）：`sendPrompt(text, images)` / `cancelTurn()` / `setMode(modeId)` / `setConfigOption(configId, value)` / `respondPermission(requestId, optionId|null)` / `authenticate(methodId)` / `resumeHistory(record)` / `getHistoryRecord(id)` / `deleteHistoryRecord(id)` / `setDraft(patch)` / `attachShellContext(selection)` / `clearShellContext()` / `startSession({project})` / `addProject()` / `deleteProject(id)` / `refreshAgents()` / `refreshHistory()` / `refreshProjects()` / `refreshRuntimeEnv()`。

旧名字 `start()` / `stop()` / `newSession()` / `reclaimAndStart()` 保留为等价入口（`newSession` = 用当前 agent 与目录新开一个 tab）。

### transcript 条目类型

```
{ id, type: "user",       text, images?: [{mimeType, previewUrl?}], context?: {sessionName, content} }
{ id, type: "assistant",  text }                    // 流式增量合并，Markdown 渲染
{ id, type: "thought",    text }                    // 思考过程，默认折叠
{ id, type: "tool",       tool }                    // 按 toolCallId 原位更新
{ id, type: "permission", requestId, toolCall, options, resolution, resolving }
{ id, type: "notice",     tone: "info"|"warning"|"error", code, detail }
```

`tool` 形状：`{toolCallId, title, kind, status, content: [块], locations: [{path, line?}], rawInput, rawOutput}`；status 取值 `pending|in_progress|completed|failed`；content 块为 `{type:"text",text}` / `{type:"diff",path,oldText?,newText}` / `{type:"terminal",terminalId}`。

`notice.code` 由 `AcpNoticeRow.jsx` 的 `noticeCopy()` 翻译：`session-ended` / `env-missing` / `start-failed` / `new-session-failed` / `project-create-failed` / `project-delete-failed` / `turn-stopped`（detail=stopReason）/ `turn-failed` / `auth-failed` / `resume-fallback` / `mode-failed` / `config-option-failed` / `permission-failed` / `agent-error`。新增文案走 code，不要在 hook 里放中文。

`noticeCopy()` 返回 `{title, body}`：`body` 为空字符串表示这一行没有正文（渲染成一行灰字，不画卡片）；否则 `body` 就是原始报错。**标题与正文必须分开**。

### 事件路由（多会话的核心）

流事件 `acp-agent-stream` 同时带 `agentId` 与 `sessionId`：

| stage | 命中依据 | 处理 |
| --- | --- | --- |
| `delta` / `thought` / `user` / `tool_call` / `tool_call_update` / `plan` / `commands` / `config_options` / `mode` / `usage` | `payload.sessionId` → 会话 | 只更新该会话 |
| `permission_request` / `permission_resolved` | 该请求所属 sessionId | 更新该会话；非活动会话靠 tab 角标提醒 |
| `stopped` | **只看 `agentId`** | 该 agent 名下**所有**会话 → `ended` |

⚠️ **`stopped` 的 `sessionId` 不可信**：后端 `SessionContext.session_id` 是单值，多会话下它是"最后建立的那个"。前端绝不能拿它路由。

⚠️ starting 阶段的回放事件可能早于启动命令返回（此时还没有 sessionId），hook 用 `agentId` 找到该 agent 唯一处于 `starting` 的会话兜底；同一 agent 的启动被 promise 链串行化，保证同时只有一个在 starting。

### 失败上报去重

hook 里所有失败通知走 `reportFailure(code, err, key?)`，不要直接 `pushNotice("error", …)`：它除了推通知还会记下时间戳，5 秒内同一个故障的重复上报（命令自身的 rejection 与随后那条 stream 事件）会被吞掉。`stopped` 事件里的 `payload.error` 走 `failureAlreadyReported()` 判断，也是同一个原因。

### ⚠️ 兼容性红线

1. **transcript 条目结构会被持久化**到 `.eshell-data/acp_sessions/*.json`，历史文件名就是 agent 的 sessionId。改结构时必须兼容旧记录（渲染端做缺省处理，或在 `sanitizeEntriesForHistory` / 读取侧做迁移）。
2. **能力门控不可去掉**：图片按钮仅在 `capabilities.promptImage` 为真时出现；模式下拉仅在 `modes.availableModes` 非空时出现；历史「打开」任何时候可点（后端不支持 `session/load` 时降级为 `acp_session_new` 并推 `resume-fallback` 通知）。
3. 权限卡片在 `resolution != null` 后必须保持只读展示（选项按钮消失，显示所选结果）。
4. **`agents[].running` 是后端真相，不是前端状态的镜像**。Rust 侧的 agent registry 比 webview 活得久：重载页面（dev HMR、devtools、前端崩溃）会让 React state 归零，但后端 runner 和 agent 子进程还在。现在这不再是死路——新会话发现该 agent 已在跑时会走 `acp_session_new` 复用进程，而不是 `acp_agent_start` 被拒。
5. **一个 agent 进程可以同时承载多个会话**（`scripts/acp-concurrency-probe.mjs` 实测）。所以任何"先停掉再开"的写法都是退化，不要加回来：新建、切换、恢复历史都不得调用 `acp_agent_stop`。
6. **`session/close` 可能不被 agent 支持**：`closeSession` 直接调用即可（后端对不支持的 agent 本地丢弃），但**不能**用"杀掉进程"来替代关闭一个会话。

## 3. 面板视图结构与交互清单

```
Tabs(34px):  [品牌标 标题 角标 ×] … [+] [项目会话] [⋮]
Context(28px): 品牌标 · agent 名 · cwd · 用量%
Body(滚动区，浮层可覆盖):
  无会话      → 启动页(环境警告 + 路径下拉 + agent 列表，点哪个用哪个开新会话)
  starting    → 骨架 + spawn 命令
  auth        → 登录卡 + transcript
  ended       → 结束/失败卡(重新开始 / 停止进程 / 关闭会话) + transcript(只读)
  ready       → transcript 流 + turnActive 转圈
History(浮层) → 按项目分组的会话列表；点一条 = 开成 tab
Plan 卡片: 常驻于滚动区与 composer 之间(可折叠，含完成度 x/y)
Composer: 终端选中 chip + 附件缩略图 + 输入盒 + 底部条(模式胶囊 / 设置胶囊 / 发送或中断)
```

### 启动页（无会话时）

```
开始一段会话                              📁 默认路径 ▾
[品牌标] Agent 名  spawn 命令                                  +
```

- **路径下拉（`AcpPathPicker`）决定新会话在哪个目录跑**。默认项不传 project，走各 agent 自己配置的 `cwd`；三个 agent 的 `cwd` 一致时下拉里直接显示那个真实路径，否则显示「各 Agent 自己配置的目录」。选中的项目走 `openSession({ agentId, project })`，与历史面板开出的会话是同一条路径。
- 下拉里的「新建项目」复用 `addProject()`（系统目录选择器 + `acp_project_create`），建完自动选中，不必绕回历史面板。
- 选择只影响**启动页**的 agent 行；tab 条的 `+` 仍用 agent 自己的目录——那时看不见这个下拉，悄悄沿用别处的选择会让人意外。
- 选中项存的是整行 `{id, name, path}` 而不是 id：项目之后被删掉，标题也还能显示当初的名字。

### tab 条

- 一项一个会话：`[品牌标] 标题 [角标] [×]`，最大宽 12rem，超出横向滚动（滚轮映射到横向，复用 `.tab-strip`）。超过 12 个只显示最近的 12 个。
- 标题取首条用户消息前 34 字；还没有消息时显示「新建会话」——**不要用 agent 名兜底**，同一个 agent 的两个新 tab 会长得一模一样（agent 身份已经由品牌标承担）。
- 角标优先级：**待审批数字 > 运行中脉动点 > 已结束灰点 > 未读点**。待审批是唯一会阻塞 agent 的状态，所以排最前。
- `+` 打开 agent 列表（每个 agent 带品牌标、spawn 命令、运行中绿点），点哪个就用哪个**新建一个 tab**，不动任何现有会话。
- `⋮` 里是 `Stop agent process`（danger，会结束该 agent 所有会话），罕见操作，不要提升为主按钮。
- 历史入口在 tab 条右侧，图标是**文件夹**（`FolderKanban`），不是箭头：它是"项目 + 会话管理"，箭头会读成"展开点什么"。按钮状态 `aria-pressed`，浮层覆盖正文区（不是替换），对话在底下仍然挂着。
- 启动页那个路径下拉用的是普通 `Folder`，两个图标刻意区分："在哪跑" vs "管理哪些会话"。

### 关闭 vs 停止

| 动作 | 触发 | 行为 |
| --- | --- | --- |
| 关会话 | tab `×` | 存档 → `acp_session_close` → 移除 tab；若是该 agent 最后一个 tab，再 `acp_agent_stop` |
| 停进程 | `⋮ → Stop agent process` | `acp_agent_stop`；该 agent 全部 tab → `ended`，**保留**可只读回看 |
| 重新开始 | `ended` 卡片 | 关掉当前 tab（必要时回收进程）后，用同 agent 同目录新开一个 |

### 历史

- 点击历史记录 = 用该记录新开一个 tab（`acp_session_load`，或进程没起时 `acp_agent_start(resumeSessionId)`）。
- 已经在 tab 里打开的记录会聚焦而不是重复打开（hook 按 `agentId + 记录 id` 判重）。
- 不再有"只读回放"模式：打开就是恢复会话。若只是看一眼，代价和收益都比多一个模式低。
- **项目行的 `+` 先选 agent 再开会话**：项目只说明"在哪个目录"，不说明"用哪个 agent"。以前这里直接取 `activeAgentId`（默认第一个，通常就是 Codex），于是从项目里新建的会话永远是同一个 agent，用户无从选择。现在它会就地展开 agent 列表（`AcpAgentMenu`，与 tab 条 `+` 同一个组件），选完才 `startSession({ project, agentId })`。
  - 就地展开而不是浮层：历史面板的正文在 `overflow-y-auto` 容器里，浮层会被裁掉。

### 其他联动

- 终端选中文本 → 右上角「Add To Agent」浮层（`XtermSelectionAction`）→ `AppMainWorkspace` 调 `acp.attachShellContext(selection)` 并打开 dock → **当前会话**的草稿出现 chip → 发送时以 fenced code block 追加到正文（transcript 条目保留结构化 `context` 字段）。没有活动会话时，选中内容暂存，随下一个新会话带入。
- 草稿（文本 / 附件 / 终端选中）是**每个会话独立**的，切走再切回内容还在；发送后整体清空。
- 行为细节：自动滚动仅在用户位于底部附近（阈值 48px）时生效；切换 tab 会重置到底部。Esc 关闭 dock 在 App.jsx，弹层和展开的 composer 都要先 `stopPropagation`。

## 3.5 会话配置项（模型 / 思考强度）

ACP 用一套 **session config options** 承载模型、思考强度这类选择器，和 `SessionModeState` 是**两套独立机制**。
链路：`NewSessionResponse.configOptions`（初始）→ `SessionUpdate::ConfigOptionUpdate`（推送全量）→ `session/set_config_option`（提交）。

`category` 语义类别：`mode` / `model` / `model_config` / `thought_level`，以及自定义（spec 规定未加 `_` 前缀的名字保留给 spec，但要求客户端**优雅处理未知与缺失**）。

### 实测结果（`scripts/acp-probe.mjs`，2026-09-05）

| agent | 声明的 option |
| --- | --- |
| Codex | `mode`(mode) / `collaboration_mode`(**非 spec 类别**) / `model`(model, 6 个) / `reasoning_effort`(thought_level, low→max) / `fast-mode`(model_config) |
| Claude Code | `mode`(mode) / `model`(model, 6 个) / `effort`(thought_level, default→max) / **第四项随所选模型变化**：Opus 下是 `fast-mode`(model_config)，自定义模型下是 `agent`(**完全没有 category**) |

⚠️ **option 集合不是「每个 agent 一张固定表」，而是随会话状态动态变化的**。所以按 **category** 过滤，不要按 option id 白名单，也不要缓存成 per-agent 常量。

由此定下的实现约束：

1. **`category === "mode"` 必须丢掉**。两个 agent 都把 mode 同时放进 `modes` 和 config options，全渲染会出现两个一样的模式选择器。面板用 `modes` + `session/set_mode`（spec 稳定机制），config 里的镜像由 `visibleConfigOptions()` 过滤。
2. **展示用白名单 `DISPLAY_CATEGORIES = [model, thought_level]`**（`acpConfigOptions.js`，改这一处即可增减）。被刻意排除的：`model_config`（两个 agent 的 "fast mode" 都在这里，产品决定不展示）、未知/缺失 category（Codex `collaboration_mode`、Claude Code `agent`）。**不影响正确性** —— 没展示的项 agent 保持自己的默认值。
3. **description 可能极长**。Claude Code 的 persona option 描述是一整段（子 agent 的完整说明），菜单行必须 `line-clamp-3`，不能假设它短。

### ⚠️ 提交值的 wire 格式（踩过的坑）

`session/set_config_option` 的 `value` 在请求**顶层**，是裸标量，**不是** `value.value`：

```
{"sessionId":"...","configId":"reasoning_effort","value":"high"}          # select
{"sessionId":"...","configId":"fast-mode","type":"boolean","value":true}  # boolean
```

codex-acp 把 `value` 校验成 `string | boolean`，传对象会被 -32602 拒掉（实测过）。Rust SDK 靠 flatten 那个 tagged enum 得到这个形状；`commands.rs` 的 `set_config_option_request_keeps_the_value_bare` 测试把它钉住了 —— SDK 升级后不再 flatten 会静默弄坏所有模型/思考强度切换。
Tauri 命令收的是**裸值**（string / bool），由 `config_option_value()` 转成 SDK 枚举，前端不需要知道 `type` 判别符。

## 4. 样式与文案约定

- Tailwind 语义 token（**定义在 `src/index.css` 的 `@theme`，只有这些能用**）：背景 `bg-bg` / `bg-surface` / `bg-panel`，边框 `border-border`，文字 `text-text` / `text-muted`，主色 `accent` / `accent-soft`，状态 `success` / `warning` / `danger`，另有 `warm`。
  - ⚠️ **`text-primary` / `text-secondary` 不存在**（Tailwind v4 对未定义 token 不报错、直接不产出 CSS，文字会退回继承色）。次级文字用 `text-text/88`，弱化文字用 `text-muted`。新增 token 前先确认 `@theme` 里有。
  - `dark:` 变体已在 `index.css` 用 `@custom-variant dark` 绑到 `[data-theme="dark"]`（主题由 JS 写 `data-theme`，**不是** `prefers-color-scheme`）。
- **工具行**（`AcpTranscript.jsx`）——一行三件事：状态、名字、展开。三条都是踩过之后定下来的：
  - **不要用左侧竖线表达状态**。状态是 12px 定宽槽里的 6px 圆点（`TOOL_STATUS_DOT`），多行天然对齐；形状也带信息：`pending` 空心、`in_progress` 脉动、`completed` 实心、`failed` 实心红。
  - **状态文字不要可见**。「已完成」在中文里是同义反复，且和圆点、颜色构成三重重复信号。现在它是 `sr-only`，可访问名仍是 `execute_command 已完成`。
  - **`kind` 徽章不要画**。所有 MCP 工具的 `kind` 后端都写死成 `"other"`，徽章恒为 `OTHER`。改用剥掉 `mcp__{server}__` 前缀的 `title`（`splitToolTitle`，按**最后**一个 `__` 切）。
  - **展开内容不缩进**。`pl-1`，和整行按钮同一个左边缘即可。
- **composer 放大**：textarea 固定 2 行，内容超出时右上角出现放大按钮（`Maximize2` / 收起时 `Minimize2`）。
  - 按钮的出现条件是**实测** `scrollHeight > clientHeight`（`composerOverflows`），不按字数猜；`ResizeObserver` 挂在**外框**上。
  - 展开高度 `h-[min(52vh,26rem)]`，textarea 同时加 `flex-1`；消息区是 `flex-1 min-h-0`，会主动让出空间。
  - **展开后按钮不能消失**：条件是 `composerOverflows || composerExpanded`。
  - Esc 收起时必须 `stopPropagation`：`App.jsx` 有全局 Esc 关整个 dock 的监听器。发送后自动收起。
  - 按钮出现时 textarea 加 `pr-9`，防止文字压在按钮底下。
- 所有用户可见文案必须走 `t("English key")` 并在 `i18n.js` 补中文；key 即英文原文。
- 图标统一 lucide-react，尺寸基准 `h-3.5 w-3.5`（行内）/ `h-4 w-4`（按钮）。Agent 品牌标识走 `AcpAgentLogo`，不要直接内联 SVG。
- 下拉/弹层沿用 `AcpPickers` 的形态：胶囊触发器 + 弹层由 **`MenuLayer`（面板满宽定位层）** 摆放，而不是挂在触发器上。dock 宽度只有 320-760px 且面板根节点 `overflow-hidden`，**按触发器定位的弹层在边缘会被裁切**。
  - **弹层本体必须点击穿透**：`MenuLayer` 挂 `pointer-events-none`，只在**菜单组**那层 `pointer-events-auto` 回来。少了这一步，点弹层周围的空白会被判定成「点在 composer 内」，面板的 outside-click 关闭永远不触发。
  - 值那一栏跟着悬浮/聚焦走，所以 `MenuPanel` 的 `autoFocus` 对它关掉。
  - 面板同时只允许一个 composer 弹层打开：`openMenu` 单值状态。tab 条的菜单自己管自己的开关。

## 5. UI 待优化清单（交接 backlog）

按价值排序，均为纯前端改动：

1. **长会话性能**：transcript 无虚拟化；多会话后同时驻留的 transcript 更多，长对话 + 流式高频 setState 会更明显。考虑虚拟列表或分段折叠历史回合。
2. **diff 渲染**：工具卡片的 diff 目前是"红块+绿块"两段 pre，无行号、无逐行对比、无语法高亮（`react-syntax-highlighter` 已在依赖里）。
3. **代码块复制按钮**：assistant Markdown 的代码块无 copy 按钮（`aiAssistantUtils.copyText` 可直接复用）。
4. **消息级操作**：无复制原文/重发/引用回复。
5. **历史列表**：无搜索、无按项目以外维度过滤、无分页；只列当前 agent 的记录。
6. **thought 折叠预览**：折叠态仅截 80 字符，可做两行 clamp + 渐隐。
7. **权限卡片**：无键盘快捷键；多个待审批时无聚合视图（tab 角标只给数量）。
8. **启动页引导**：缺 Node.js 时挂 `AcpEnvWarningCard` 已做；仍缺"这个 agent 需要先登录"的主动引导。
9. **composer**：不支持拖拽图片落入（图片按钮已按设计移除，只保留粘贴）；放大是手动切换，不随内容自动增高。
10. **plan 卡片**：固定占位，任务多时挤压消息区，可改为可收纳角标/抽屉。
11. **usage 徽标**：可升级为点击弹层（含 token 明细、成本，后端 `usage_update` 里有 cost 字段未透传）。
12. **工具调用聚合**：连续同类型的已完成调用仍逐条平铺，可参考 Claude Code 的 `groupToolUses` 折叠成一行计数；进行中的条目永不折叠。
13. **tab 持久化**：重载后 tab 列表消失（后端 runner 还在，靠 `acp_session_new` 复用）。可把 tab 描述存 localStorage 并在启动时 `session/load` 重连。
14. **后台会话的提醒**：目前只有 tab 角标；标题栏 AI 按钮上没有待审批红点。
15. **Agent 品牌覆盖**：`acpAgentBrands.js` 目前收录 OpenAI(Codex) / Anthropic(Claude Code) / OpenCode / Gemini / Qwen，其余回退中性图标；新增品牌只需加一条（glyph + 匹配正则 + 双主题配色）。

## 6. 本地验证

```bash
npm run test          # vitest
npx vite build        # 构建校验
node scripts/acp-concurrency-probe.mjs claude-agent-acp   # 多会话并发 / session/close 实测
cd src-tauri && cargo test --lib                          # 后端契约
npm run tauri dev     # 冒烟：见下
```

冒烟清单（多会话）：

1. `+` 连开两个 agent → 两个 tab 都在跑，互不打断。
2. 同一 agent 开两个 tab，同时发消息 → 两条流各自到达自己的 tab。
3. A tab 长 turn 中切到 B 发消息 → B 立即响应，A 继续在后台流式；切回 A 看到完整内容。
4. 在 A 触发权限请求后切到 B → A 的 tab 上是数字角标，切回去能点。
5. 关闭 A → B 不受影响；关闭该 agent 最后一个 tab → 进程退出。
6. 历史面板打开一条旧会话（该 agent 已在跑）→ 新 tab 打开并回放。
7. `⋮ → Stop agent process` → 该 agent 全部 tab 变 `ended`，composer 禁用。
