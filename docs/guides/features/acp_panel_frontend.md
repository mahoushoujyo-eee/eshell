# ACP 面板前端指南（UI 交接文档）

本文面向**接手 ACP 聊天面板 UI 优化**的开发者：组件结构、状态契约、交互清单、样式约定，以及已知的 UI 待优化项。协议与后端实现见 [ACP Agent 指南](acp_agent.md)。

核心原则：**视图层是纯渲染**。所有状态与副作用都在 `useAcpAgent` hook 里；改 UI 不需要动 hook 和 Rust，只要不破坏下述契约。

## 1. 文件清单

| 文件 | 职责 |
| --- | --- |
| `src/components/panels/AcpAgentPanel.jsx` | 面板主体 UI（内含 transcript / 卡片 / composer 等子组件） |
| `src/components/panels/acp/AcpPickers.jsx` | 两个下拉：Agent 选择器（标题栏，含 logo/spawn 命令/进程状态）与会话模式选择器（composer 右下角，向上弹） |
| `src/components/ai/AcpAgentLogo.jsx` | 单个 Agent 的品牌标识（未识别品牌回退中性图标） |
| `src/lib/acpAgentBrands.js` | 品牌注册表 + 匹配逻辑（`acpAgentBrands.test.js` 覆盖） |
| `src/lib/acpConfigOptions.js` | 会话配置项（模型/思考强度/…）的过滤、排序、分组、当前值取名（`acpConfigOptions.test.js` 覆盖） |
| `scripts/acp-probe.mjs` | 探针：直接跟 agent 握手并打印 `session/new` 实际返回，用于确认某个 agent 到底 advertise 什么 |
| `src/hooks/useAcpAgent.js` | 会话状态机：事件路由、transcript 组装、历史持久化、全部 action |
| `src/components/app/AppAiDock.jsx` | 右侧 dock 容器：宽度/拖拽/显隐动画 |
| `src/App.jsx` | 创建 hook 实例；dock 宽度状态；Esc 关闭；面板打开时刷新 agent 列表 |
| `src/components/app/AppWorkspace.jsx` | 标题栏 AI 按钮 ↔ `showAiPanel`；繁忙指示 = `acp.turnActive` |
| `src/lib/tauri-api.js` | `acp*` 命令封装（全部后端调用入口） |
| `src/lib/i18n.js` | 文案（英文原文为 key，中文在 `zhMessages`，缺失时回退英文） |

复用组件：Markdown 渲染用 `ReactMarkdown` + `MARKDOWN_COMPONENTS`（来自 `ai-assistant/aiAssistantUtils.jsx`，样式类 `.ai-markdown` 在全局 CSS）。图标一律 `lucide-react`。

## 2. 状态契约（hook 返回值）

```
agents            [{id, name, command, args, running}]
activeAgentId     当前选中 agent（ready/starting 时选择器应禁用）
phase             "idle" | "starting" | "auth" | "authenticating" | "ready"
session           null | { agentId, agentName, id, modes, agentInfo, capabilities, createdAt }
  modes           null | { currentModeId, availableModes: [{id, name, description?}] }
  capabilities    null | { loadSession, promptImage }   ← 功能门控依据
authMethods       [{id, name, description?}]            ← phase 为 auth 时展示
transcript        条目数组（见下）
plan              null | [{content, priority, status}]  status: pending|in_progress|completed
commands          [{name, description, inputHint?}]     ← 斜杠命令补全数据
configOptions     [{id, name, description?, category?, type, currentValue, options?}]
                  ← agent 声明的选择器；agent 每次变更都推**全量**，只能整体替换
usage             null | {used, size}                   ← 上下文用量
turnActive        bool（回合进行中；标题栏繁忙指示同源）
history           [{id, agentId, agentName, title, createdAt, updatedAt, entryCount}]
shellContext      null | {sessionId, sessionName, content}   ← 终端选中内容暂存（≤4000 字符）
```

Actions：`start()` / `stop(agentId?)`（省略 agentId = 当前 engaged 的 agent） / `reclaimAndStart(agentId)` / `authenticate(methodId)` / `setConfigOption(configId, value)` / `sendPrompt(text, images)` / `cancelTurn()` / `setMode(modeId)` / `respondPermission(requestId, optionId|null)` / `resumeHistory(record)` / `getHistoryRecord(id)` / `deleteHistoryRecord(id)` / `attachShellContext(selection)` / `clearShellContext()` / `refreshAgents()` / `refreshHistory()`。

### transcript 条目类型

```
{ id, type: "user",       text, images?: [{mimeType, previewUrl?}], context?: {sessionName, content} }
{ id, type: "assistant",  text }                    // 流式增量合并，Markdown 渲染
{ id, type: "thought",    text }                    // 思考过程，默认折叠
{ id, type: "tool",       tool }                    // 按 toolCallId 原位更新
{ id, type: "permission", requestId, toolCall, options, resolution, resolving }
{ id, type: "notice",     tone: "info"|"error", code, detail }
```

`tool` 形状：`{toolCallId, title, kind, status, content: [块], locations: [{path, line?}], rawInput, rawOutput}`；status 取值 `pending|in_progress|completed|failed`；content 块为 `{type:"text",text}` / `{type:"diff",path,oldText?,newText}` / `{type:"terminal",terminalId}`。

`notice.code` 由 `NoticeRow` 翻译：`session-ended` / `start-failed` / `turn-stopped`（detail=stopReason）/ `turn-failed` / `auth-failed` / `mode-failed` / `permission-failed` / `agent-error` / `resume-fallback`。新增文案走 code，不要在 hook 里放中文。

### ⚠️ 兼容性红线

1. **transcript 条目结构会被持久化**到 `.eshell-data/acp_sessions/*.json`（历史回看直接用同一渲染组件）。改结构时必须兼容旧记录（渲染端做缺省处理，或在 `sanitizeEntriesForHistory` / 读取侧做迁移）。
2. **能力门控不可去掉**：图片按钮仅在 `capabilities.promptImage` 为真时出现；模式下拉仅在 `modes.availableModes` 非空时出现；历史「恢复」按钮任何时候可点（后端不支持 loadSession 会自动降级并发 `resume-fallback` 通知）。
3. 权限卡片在 `resolution != null` 后必须保持只读展示（选项按钮消失，显示所选结果）。
4. **`agents[].running` 是后端真相，不是前端状态的镜像**。Rust 侧的 agent registry 比 webview 活得久：重载页面（dev HMR、devtools、前端崩溃）会让 React state 归零（`phase` 回 `idle`、`session`/`engagedAgentRef` 变 null），但后端 runner 和 agent 子进程还在 —— 此时 `acp_agent_start` 会拒绝并报 `already has an active session`。
   面板据此判定"残留会话"：`phase === "idle" && activeAgent.running` → 渲染 `OrphanedSessionCard`（停止并启动 / 仅停止），标题栏停止按钮也一并放开。**不要把停止入口重新收窄到只有 `ready` 时可见**，否则这个状态就再次无法自救（`stop()` 不带参数时取 `session || engagedAgentRef`，重载后两者皆空会直接 return）。
   注意 `acp_agent_stop` 一个未 engaged 的 agent 时，`stopped` 事件会被 stream 过滤器丢弃，所以 `stop(agentId)` 里要自己 `refreshAgents()`。

## 3. 面板视图结构与交互清单

```
Header:  Agent 选择器(logo + 名称 + 运行中绿点 + tooltip=spawn 命令)
         + 用量% 徽标(tooltip=原始数) + 历史按钮 + 停止按钮(ready 或残留会话时) + 关闭 X
         标题 h2 为 sr-only（视觉识别由 Agent logo + 名称承担）
Body(滚动区，按优先级互斥):
  historyOpen → 历史列表(查看/恢复/删除) | 单条只读回放(返回/恢复)
  authActive  → 登录卡片(方法按钮/等待中+取消/手动配置提示) + notices
  idle 且无记录 → 启动页(说明 + spawn 命令预览 + 启动按钮)
  其他        → transcript 流 + turnActive 转圈 + (idle 且有记录时顶部"重新启动")
Plan 卡片: 常驻于滚动区与 composer 之间(可折叠，含完成度 x/y)
Composer: 终端选中内容 chip(会话名+预览+字数+可删) + 附件缩略图条(可删)
          + 带边框的输入盒: textarea(Enter 发送/Shift+Enter 换行/粘贴图片)
            + 溢出时右上角出现放大按钮(见 §4「composer 放大」)
            + 底部条(border-t): 模式胶囊 + 会话设置胶囊(齿轮 + 当前模型 · 当前思考强度) + 圆形发送/中断按钮(最右)
              会话设置 = 一个胶囊收纳全部 config option；胶囊内**直接显示当前值**(模型名跑得长，
              14rem 截断，完整 "Name: value" 列表在 tooltip)。
              菜单是**一个双栏单元**：左栏每行一个设置(名称+当前值)，右栏是该行可选值。右栏**常驻**，
              默认展示第一行(模型)，悬浮/聚焦别的行只替换右栏内容(boolean 行直接点击切换，右栏不动)，
              整组同生同灭 —— 不要让右栏变成靠悬浮弹进弹出的独立面板(滑开就只剩左栏悬着，且整组会横向跳动)
          斜杠补全: 输入以 "/" 开头且无空格时，在 composer 上方浮层列出匹配命令
          ⚠️ **没有图片按钮**：图片只能粘贴进 textarea（`capabilities.promptImage` 门控 onPaste）。
             这是刻意删掉的，别再加回一个方块按钮；要补录入方式的话做拖拽落入。
```

工具行（`ToolCallCard`）与思考行（`ThoughtEntry`）是 transcript 里最密集的两种行，视觉约定见 §4「工具行」——
**不要给它们加左侧竖线，也不要给展开内容加缩进**，两条都是踩过之后删掉的。

终端选中联动：在终端选中文本 → 右上角「Add To Agent」浮层（`XtermSelectionAction`）→
`AppMainWorkspace` 调 `acp.attachShellContext(selection)` 并打开 dock → composer 出现 chip →
发送时以 fenced code block 追加到正文（transcript 条目保留结构化 `context` 字段，气泡内折叠展示）。

行为细节：自动滚动仅在用户位于底部附近（阈值 48px）时生效；`nearBottomRef` 在发送时强制置真。Esc 关闭 dock 在 App.jsx。dock 隐藏时面板**不卸载**（状态保留）。

## 3.5 会话配置项（模型 / 思考强度）

ACP 用一套 **session config options** 承载模型、思考强度这类选择器，和 `SessionModeState` 是**两套独立机制**。
链路：`NewSessionResponse.configOptions`（初始）→ `SessionUpdate::ConfigOptionUpdate`（推送全量）→ `session/set_config_option`（提交）。

`category` 语义类别：`mode` / `model` / `model_config` / `thought_level`，以及自定义（spec 规定未加 `_` 前缀的名字保留给 spec，但要求客户端**优雅处理未知与缺失**）。

### 实测结果（`scripts/acp-probe.mjs`，2026-09-05）

| agent | 声明的 option |
| --- | --- |
| Codex | `mode`(mode) / `collaboration_mode`(**非 spec 类别**) / `model`(model, 6 个) / `reasoning_effort`(thought_level, low→max) / `fast-mode`(model_config) |
| Claude Code | `mode`(mode) / `model`(model, 6 个) / `effort`(thought_level, default→max) / **第四项随所选模型变化**：Opus 下是 `fast-mode`(model_config)，自定义模型下是 `agent`(**完全没有 category**) |

⚠️ **option 集合不是「每个 agent 一张固定表」，而是随会话状态动态变化的**（同一个 Claude Code，探针里给 `agent`、实际选 Opus 时给 `fast-mode`）。所以按 **category** 过滤，不要按 option id 白名单，也不要缓存成 per-agent 常量。

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
  - ⚠️ **`text-primary` / `text-secondary` 不存在**（本面板早期版本用过，Tailwind v4 对未定义 token 不报错、直接不产出 CSS，文字会退回继承色）。次级文字用 `text-text/88`，弱化文字用 `text-muted`。新增 token 前先确认 `@theme` 里有。
  - `dark:` 变体已在 `index.css` 用 `@custom-variant dark` 绑到 `[data-theme="dark"]`（主题由 JS 写 `data-theme`，**不是** `prefers-color-scheme`）。
  - 状态色已全部迁到 `success` / `warning` / `danger` 语义 token（26 处），面板里不再有裸 emerald / amber / red。
- **工具行**（`ToolCallCard` / `ThoughtEntry`）——一行三件事：状态、名字、展开。三条都是踩过之后定下来的，改之前先读完：
  - **不要用左侧竖线表达状态**。原来是每行 `border-l-2` + 状态色，连续几条工具调用排在一起就是一道彩色栅栏，非常「人机」。现在状态是 12px 定宽槽里的 6px 圆点（`TOOL_STATUS_DOT`），多行天然对齐。形状也带信息，不只靠颜色：`pending` 空心、`in_progress` 脉动、`completed` 实心、`failed` 实心红。
  - **状态文字不要可见**。「已完成」在中文里是同义反复，且和圆点、颜色构成三重重复信号。现在它是 `sr-only`，可访问名仍是 `execute_command 已完成`，读屏和 tooltip 都还在。
  - **`kind` 徽章不要画**。所有 MCP 工具的 `kind` 后端都写死成 `"other"`（`src-tauri/src/domain/agent/service/acp_client.rs`），徽章恒为 `OTHER`，纯噪音。改用剥掉 `mcp__{server}__` 前缀的 `title`（`splitToolTitle`，按**最后**一个 `__` 切，server 名本身含下划线时才正确），server 不逐行重复显示，完整名放 `title`。
  - **展开内容不缩进**。`pl-1`，和整行按钮同一个左边缘即可。竖线删掉后再补一个缩进，只是把一种错位换成另一种。
- **composer 放大**：textarea 固定 2 行，内容超出时右上角出现放大按钮（`Maximize2` / 收起时 `Minimize2`）。
  - 按钮的出现条件是**实测** `scrollHeight > clientHeight`（`composerOverflows`），不按字数猜：换行量取决于 dock 宽度，而宽度用户随时能拖。`ResizeObserver` 挂在**外框**上，textarea 自身盒子高度不变，观察它测不到。
  - 展开高度 `h-[min(52vh,26rem)]`，textarea 同时加 `flex-1`；消息区是 `flex-1 min-h-0`，会主动让出空间而不是把面板撑破。
  - **展开后按钮不能消失**：展开后通常就不再溢出，若条件写成 `composerOverflows` 按钮会一起消失，用户再也回不去。条件是 `composerOverflows || composerExpanded`。
  - Esc 收起时必须 `stopPropagation`：`App.jsx` 有全局 Esc 关整个 dock 的监听器，不拦会连面板一起关。发送后自动收起。
  - 滚动条**两种状态都保留**——展开只是加空间，不替代滚动。
  - 按钮出现时 textarea 加 `pr-9`，否则最后几个词会压在按钮底下。这条是防重叠，不是缩进，别为了「对齐」去掉。
- 所有用户可见文案必须走 `t("English key")` 并在 `i18n.js` 补中文；key 即英文原文。
- 图标统一 lucide-react，尺寸基准 `h-3.5 w-3.5`（行内）/ `h-4 w-4`（按钮）。Agent 品牌标识走 `AcpAgentLogo`，不要直接内联 SVG。
- 下拉/弹层沿用 `AcpPickers` 的形态：胶囊触发器 + 弹层由 **`MenuLayer`（面板满宽定位层）** 摆放，而不是挂在触发器上。dock 宽度只有 320-760px 且面板根节点 `overflow-hidden`，**按触发器定位的弹层在边缘会被裁切**；满宽层 + flex 对齐则能「贴着自己的按钮、又永远在面板内」：
  - Agent 选择器：`side="bottom"` + `justify-start`（按钮在标题栏左侧）。
  - 模式选择器：`side="top"` + `justify-start`（胶囊在底部条左侧）。
  - 会话设置：`side="top"` + `align="start"` + `inset={触发器 offsetLeft}`（DOM 顺序即「列表→值」，`flex-row` 下左边列表、右边值，tab 顺序也和视觉一致）。它在底部条里排在模式胶囊**之后**，不是贴着面板左边缘，所以量一下自己的 `offsetLeft` 把层内缩过去（满宽层与触发器同一坐标系），弹层才真的「紧挨着按钮」而不是贴在面板边上。两栏**都**是 `min-w-0 shrink`，窄 dock 下按宽度比例一起压缩，谁也不会被挤出面板（13rem + 15rem 在 320px 的 dock 里放不下，所以两栏都必须能缩）。
  - 早期版本所有底部菜单都用 `bottom-full right-0` 满宽 sheet，导致点任何胶囊都从右下角弹出 —— 不要退回那种写法。
- **弹层本体必须点击穿透**：`MenuLayer` 是满宽盒子、又长在 composer 里，所以它挂 `pointer-events-none`，只在**菜单组**那层 `pointer-events-auto` 回来（挂在组上而不是每个面板上，两栏之间的 gap 才算菜单的一部分）。少了这一步，点弹层周围的空白会被判定成「点在 composer 内」，面板的 outside-click 关闭永远不触发，菜单只剩按钮能关。
- 值那一栏跟着悬浮/聚焦走，所以 `MenuPanel` 的 `autoFocus` 对它关掉（抢焦点会和鼠标打架）；列表与值同属一个 `MenuLayer`，两者之间的间隙由组的 `gap` 提供，鼠标跨过去不会误触。
- 面板同时只允许一个弹层打开：`openMenu` 单值状态在 `AcpAgentPanel`，外部点击/Esc 的判定要同时排除 `headerMenuRef` 和 `composerMenuRef` 两个区域。

## 5. UI 待优化清单（交接 backlog）

按价值排序，均为纯前端改动：

1. **长会话性能**：transcript 无虚拟化，长对话 + 流式高频 setState 会卡；考虑虚拟列表或分段折叠历史回合。
2. **diff 渲染**：工具卡片的 diff 目前是"红块+绿块"两段 pre，无行号、无逐行对比、无语法高亮（`react-syntax-highlighter` 已在依赖里）。
3. **代码块复制按钮**：assistant Markdown 的代码块无 copy 按钮（`aiAssistantUtils.copyText` 可直接复用）。
4. **消息级操作**：无复制原文/重发/引用回复。
5. **历史列表**：无搜索、无按 agent 过滤、无分页。（相对时间本地化已做，见 `formatRelativeTime`。）
6. **thought 折叠预览**：折叠态仅截 80 字符，可做两行 clamp + 渐隐。
7. **权限卡片**：无键盘快捷键；多个待审批时无聚合视图。
8. **启动页**：已带 Agent logo + 名称 + spawn 命令（`break-all`），但仍缺"这个 agent 需要先登录/装什么"之类引导。
9. **composer**：已支持一键放大编辑（见 §4），但仍**不支持拖拽图片落入**（图片按钮已按设计移除，只保留粘贴）。另外放大是手动切换，不随内容自动增高。
10. **plan 卡片**：固定占位，任务多时挤压消息区，可改为可收纳角标/抽屉。
11. **usage 徽标**：可升级为点击弹层（含 token 明细、成本，后端 `usage_update` 里有 cost 字段未透传）。
12. **工具调用聚合**：连续同类型的已完成调用（如 5 条 `execute_command`）仍逐条平铺，去掉竖线后栅栏感没了但重复本身仍占屏。可参考 Claude Code 的 `groupToolUses`（`docs/refer_proj/claude-code/src/utils/groupToolUses.ts`）按「同类型 + ≥N 条 + 均已结束」折叠成一行计数；进行中的条目永不折叠。注意 eShell 没有 messageId 分组键，得用「时间连续 + 标题相同 + 全部非 running」代替。
13. **与 webshell 断连遮罩的视觉统一**（见 [webshell 会话指南](webshell_session.md)）。
14. **Agent 品牌覆盖**：`acpAgentBrands.js` 目前收录 OpenAI(Codex) / Anthropic(Claude Code) / OpenCode / Gemini / Qwen 的官方 mark，其余 agent 回退中性 Bot 图标；新增品牌只需往注册表加一条（glyph + 匹配正则 + 双主题配色）。

## 6. 本地验证

```bash
npm run test          # vitest（425 例 / 40 文件）
npx vite build        # 构建校验
cd src-tauri && cargo test --lib acp mcp_bridge   # 后端契约未破坏
npm run tauri dev     # 冒烟：启动 agent → 对话 → 工具/权限/计划/历史/图片
```

没有真实 agent 时可只起 `vite` 看静态形态；完整冒烟需要已登录的 Codex/Claude Code（见 [ACP Agent 指南 4.6](acp_agent.md)）。
