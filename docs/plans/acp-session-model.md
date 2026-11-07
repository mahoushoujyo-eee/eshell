# ACP 面板会话模型重构（多会话 / 无中断切换）

日期：2026-11-06
状态：已实施（P1–P3）；见文末「实施记录」
分支建议：`feat/acp-multi-session`

## 1. 问题

现在的面板是**单会话状态机**：全局只有一份 `phase`、一份 `session`、一份 `transcript`。用户想做的三件事——开新对话、换 agent、回看历史——全部被逼成"先把当前这个停掉"。

四处硬门槛把它们锁死了：

| 门槛 | 位置 | 后果 |
| --- | --- | --- |
| `startAgent` 只接受 `phase === "idle"` | `src/hooks/useAcpAgent.js:505` | 任何时刻只能有一个会话 |
| `resumeHistory` 要求 `phase === "idle"` | `src/hooks/useAcpAgent.js:547` | 会话进行中打开历史会**静默 return**，连提示都没有 |
| `startSession` 非 idle 直接 return | `src/hooks/useAcpAgent.js:672` | 项目组里的「＋」在会话中点了没反应 |
| Agent 选择器 `locked={ready \|\| starting}` | `src/components/panels/AcpAgentPanel.jsx:1199`、`src/components/panels/acp/AcpPickers.jsx:178` | 换 agent 被锁死，tooltip 写着 "Stop the agent to switch" |

而 `stop()` 的语义是**杀进程**（`src-tauri/src/domain/agent/command.rs:115`、`src-tauri/src/domain/agent/service/acp_client.rs:323`）。于是"切一下"的实际代价是：当前对话存档 → 子进程退出 → 重新握手 → 重新建会话，约 3-5 秒，且旧对话再也回不到前台。

### 完整摩擦清单

1. 开局必须先选 agent、再点「开始」，没有"直接开一个新对话"。
2. 换 agent = 先停进程。
3. 同 agent 点「＋」会**替换**当前对话（存档后重开），旧对话不能留成 tab。
4. 换历史会话必须先 idle，再进「项目」视图、翻记录、点恢复。
5. 历史是一块**替换整个滚动区的模式**，不是常驻列表；看完要退出。
6. Codex 和 Claude Code 无法同时存在（前端只有一份会话状态；**后端本来支持**，`runners` 就是按 agentId 存的 Map）。
7. 没有后台会话：切走就没有转圈/未读/待审批提醒。**权限请求只挂在当前 transcript 里，切走就看不见，agent 会一直卡着。**
8. 「关闭」和「停止」语义混在一起：红色停止键同时表示"关这个对话"和"杀掉这个 agent 的一切"。

## 2. 实测结论（决定方案走向）

新增 `scripts/acp-concurrency-probe.mjs`，直接对真 agent 说裸 ndjson JSON-RPC：

```bash
node scripts/acp-concurrency-probe.mjs claude-agent-acp
```

对 `claude-agent-acp@0.93.0` 的实测（2026-11-06，Windows）：

| 观测项 | 结果 |
| --- | --- |
| `agentCapabilities.sessionCapabilities` | `{ additionalDirectories, close, delete, fork, list, resume, systemPrompt }` |
| `loadSession` / `promptCapabilities.image` | YES / YES |
| 同一进程两个 `session/new` | 成功，sessionId 不同 |
| 两会话并发 prompt | **并发**：A 2.4s→13.7s（257 条 update），B 3.2s→15.2s（146 条 update），B 的整个回合落在 A 回合之内，两条流交错到达 |
| `session/close` | accepted；关掉 B 后再 prompt B 报 `Internal error`，A 照常工作 |
| 单次 `session/new` 耗时 | 首次约 1.7s，后续约 1.0s（每个会话各自初始化一次 SDK） |

结论：

- **采用「一个 agent 进程 + N 个会话」**，不为每个 tab 起独立进程。省内存、省握手、`agents[].running` 语义不变。
- **关 tab 可以真的释放会话**（`session/close`），不是"假装关掉"。
- 进程仍是单点故障：agent 崩了，它名下的所有 tab 一起结束 —— 这是用资源换隔离性的自觉选择。

### 探针没回答、需要在实现中兜底的

- **codex-acp 未验证**（本机 Codex 未登录）。若某个 agent 内部串行，同一 agent 的多个 tab 会互相排队，但**不会坏**：协议层仍各自独立，只是 turn 变慢。
- `session/list` / `session/resume` 可跨进程列会话、恢复会话，比本地 JSON 历史更权威，但**本轮不做**（见 §9）。

## 3. 目标模型

```
┌────────────────────────────────────────────────────────────┐
│ ◉ Codex·重构会话 ✕ │ ● Claude ③ ✕ │ ◌ Codex ✕ │  +       │ 34px tab 条
├────────────────────────────────────────────────────────────┤
│ ⟡ Codex  D:\proj\eshell ▾        plan · 模型/思考  82%     │ 会话头
│                                                            │
│ transcript（每个 tab 各一份，流式只更新自己那份）           │
│                                                            │
│ Plan ▸ 3/7                                                 │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ ✎ 消息…                          [模式▾][设置▾] [发送] │ │
│ └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

原则：

1. **tab = 一个会话**，与 agent 进程是多对一。
2. **任何操作都不打断别的会话**：新建、切换、恢复历史都是"加一个 tab"或"切一个 tab"。
3. **后台会话继续跑**，并用角标表达状态（运行中 / 未读 / 待审批）。
4. **关闭 tab** 只结束那个会话；最后一个 tab 关闭时才回收 agent 进程。
5. **agent 身份跟着 tab 走**，不再是全局选择——所以那个 `locked` 的选择器连同问题一起消失。

## 4. 前端状态模型

`useAcpAgent` 重写为多会话（保留文件名与对外语义，内部换模型）：

```js
// 一个 tab 一份，key 是前端本地 id，与 agent 的 sessionId 分离
SessionState = {
  key,                      // "s1" | "s2" …（本地自增，稳定）
  agentId, agentName,
  sessionId,                // agent 返回的 id；starting 阶段为 null
  phase,                    // "starting" | "auth" | "authenticating" | "ready" | "ended"
  cwd, projectId,
  transcript, plan, commands, configOptions, usage, modes,
  turnActive,
  unread,                   // 非活动时到达的 assistant 文本条数
  draft,                    // { text, attachments, shellContext } —— 每个 tab 独立
  title,                    // 首条用户消息截断，与历史记录标题同规则
  createdAt,
}

// hook 返回
{
  sessions: SessionState[],
  activeKey,
  setActiveKey,
  openSession({ agentId, project, resume }),
  closeSession(key),
  stopAgent(agentId),               // 危险操作：杀掉进程（该 agent 所有 tab → ended）
  sendPrompt(text, images),         // 作用于 activeKey
  cancelTurn(), setMode(), setConfigOption(), respondPermission(),
  attachShellContext(),             // 挂到 activeKey 的草稿上
  …（其余保持现有签名，内部按 activeKey 取会话）
}
```

### 4.1 事件路由

流事件本来就带 `sessionId`（`agent_id` / `session_id` 都在 `AcpStreamEvent` 上），只是现在被完全忽略。路由规则：

| stage | 命中依据 | 处理 |
| --- | --- | --- |
| `delta` / `thought` / `user` / `tool_call` / `tool_call_update` / `plan` / `commands` / `config_options` / `mode` / `usage` | `payload.sessionId` → tab | 只更新该 tab |
| `permission_request` / `permission_resolved` | `requestId` → 该请求所属 sessionId → tab | 更新该 tab；若 tab 非活动则加角标 |
| `stopped` | **忽略 `sessionId`，按 `agentId`** | 该 agent 名下**所有** tab → `ended` |

两个必须写进注释的坑：

- **`stopped` 的 `sessionId` 是过期的**。后端取的是 `SessionContext.session_id` 这个单值 mutex（`acp_client.rs:519`），多会话时它是"最后建立的那个"。前端绝不能用它做路由。
- **starting 阶段的事件没有可靠 sessionId**（`session/load` 回放会早于启动命令返回）。办法：按 `agentId` 找到当前处于 `starting` 的那个 tab；同一 agent 的启动用**串行队列**（见 4.2），保证同时只有一个在 starting。

### 4.2 同一 agent 的启动串行化

`acp_agent_start` 在 runner 已在跑时会硬报错 `already has an active session`（`command.rs:77`）。前端按 agentId 维护一条 promise 队列：

```
openSession(agentId) →
  该 agent 已有 runner ? acp_session_new(agentId, cwd)
                        : 排队 → acp_agent_start(agentId, resumeSessionId, cwd)
```

否则连点两下「＋」会撞车。

## 5. 后端改动

### 5.1 多会话的记账（实施时简化了）

原方案打算把 `SessionContext.session_id: Arc<StdMutex<String>>` 换成 `HashSet<SessionId>`，用来在 `stopped` 里报告"这批会话都结束了"。实施时发现**没有必要**：

- 前端已经按 `agentId` 路由 `stopped`，一个 agent 的所有 tab 一起变 `ended`，不依赖后端列出会话；
- prompt / cancel / set_mode / set_config_option 本来就都从入参取 sessionId，后端不需要维护集合；
- `session/close` 是"发出去就完"，也不需要记账。

所以只保留了原来那个"最后建立的 session id"（`stopped` 事件继续带它，但**前端不得使用**）。少一个共享可变集合，就少一处多线程下的状态。**协议层完全没改**。

### 5.2 新增 `acp_session_close`

```rust
// input: { agentId, sessionId }
#[tauri::command] pub async fn acp_session_close(...) -> Result<(), String>
```

- agent 广告了 `sessionCapabilities.close` → 发 `session/close`；
- 没广告 → 直接 `Ok(())`（本地忘掉即可；杀进程会连坐其它会话，不能用来替代关闭）。
- 语义：**只结束这个会话，不动进程**。

### 5.3 新增 `acp_session_load`

现在只有 `acp_agent_start` 能恢复历史，而它要求该 agent 根本没在跑。也就是说：**agent 已在跑时，无法把历史会话重开成 tab**——这正是"回看历史必须先停"的根因。

```rust
// input: { agentId, sessionId, cwd? }
#[tauri::command] pub async fn acp_session_load(...) -> Result<AcpStartInfo, String>
```

对应 `SessionRequest::LoadSession { session_id, cwd, reply }`，在 `park_loop` 里发 `session/load`（复用 `establish_session` 已有的 load 分支）。不支持 `loadSession` 的 agent 返回错误，前端降级为 `acp_session_new` 并推 `resume-fallback` 通知（现有文案可复用）。

### 5.4 能力透传

`AcpAgentCapsView` 补 `close_session: bool`（`load_session` / `prompt_image` 旁边），前端据此决定关 tab 是"真释放"还是"本地假装"。

### 5.5 命令契约一览（全部为增量，不改既有签名）

| 命令 | 变化 |
| --- | --- |
| `acp_session_close` | **新增** |
| `acp_session_load` | **新增** |
| `acp_agent_start` | 不变（仍用于"该 agent 没有进程"时的首个会话） |
| `acp_session_new` | 不变（该 agent 已有进程时的后续会话） |
| 其余 | 不变 |

既有前端调用全部可用，改动可增量落地、可回滚。

## 6. 交互规格

### 6.1 tab 条

- 位置：面板顶部，高 34px，`border-b`，横向滚动（复用 `.tab-strip` 的 wheel→横向滚动逻辑）。
- 每个 tab：`[agent 品牌标] 标题 [状态点/角标] [×]`，最大宽 12rem，超出截断。
- 状态点：`turnActive` → `animate-pulse` 强调色；`ended` → 灰点；有 `pendingPermissions` → 数字角标（最多 `9+`）；非活动且有 `unread` → 数字角标（优先级：待审批 > 运行中 > 未读 > 空闲）。
- `×` 只在活动 tab 或 hover 时显示（与标题栏的终端 tab 一致）。
- `+` → 弹 agent 列表（品牌标 + 名称 + 进程是否在跑）→ 点哪个就用哪个开新 tab。
- tab 条按 `createdAt` 排序，不按最近使用重排（位置稳定比"最近用过"更重要）。

### 6.2 会话头

- 品牌标 + agent 名 + cwd 胶囊（点击 → 切项目/目录，等价于现在项目组里的「＋」）+ 用量徽标。
- **不再有全局 agent 下拉**。想换 agent 就是 `+` 开一个新的。

### 6.3 关闭 / 停止分离

| 动作 | 触发 | 行为 |
| --- | --- | --- |
| 关会话 | tab `×` | 存档 transcript → `acp_session_close` → 移除 tab；若是该 agent 最后一个 tab，再 `acp_agent_stop` |
| 停进程 | 溢出菜单「⋮」→ Stop agent process（danger） | `acp_agent_stop` → 该 agent 所有 tab → `ended`，**保留**（可只读回看，不自动关） |

`ended` 的 tab 保留在 tab 条里，composer 禁用并显示「会话已结束」，可一键"重新开始"（= 用同 agent + 同 cwd 开新 tab 替换）。

### 6.4 历史

- 历史不再是"模式"，改成从工具栏按钮弹出的**面板**（宽度同 dock，浮在 transcript 上）。
- 点击一条记录 → 直接开 tab：该 agent 有进程则 `acp_session_load`，否则 `acp_agent_start(..., resumeSessionId)`。
- 记录已被别的 tab 打开 → 聚焦那个 tab，不重复开（按 `agentId + 记录 id` 判重）。
- 项目的新增/删除留在历史面板里。

### 6.5 后台与提醒

- 非活动 tab 收到 assistant 文本 → `unread++`；切过去清零。
- 非活动 tab 收到权限请求 → 角标 + tab 闪一次；`XtermSelectionAction` 那一套浮层不动。
- 标题栏 AI 按钮：`turnActive` 保持现有 busy 动效；额外有 `pendingPermissions` 时加一个小红点（可选，见 §9）。

### 6.6 草稿与终端选中

- `draft`（文本 / 附件 / 终端选中）挂在**每个 tab** 上，切走再切回内容还在。
- 终端「Add To Agent」→ 挂到**当前活动 tab** 的草稿；若面板没开则先开面板再挂。
- 附件是 base64 内存对象，随 tab 关闭释放；不要跨会话共享。

## 7. 兼容与迁移

- **历史记录文件结构不变**（`.eshell-data/acp_sessions/*.json`），`sanitizeEntriesForHistory` 不动。
- transcript 条目结构不变 → 旧记录仍可只读回放。
- `AcpAgentPanel` 的四种正文视图（启动页 / 登录卡 / transcript / 历史）改为按 **active tab 的 phase** 分支；历史从分支里移出（变成浮层）。
- dock 不卸载（`KeepAlive`）的既有行为不变，tab 状态天然保留。
- 本轮**不持久化 tab 列表**：重载后回到"没有 tab"的状态（后端 runner 仍是残留，现有的 `OrphanedSessionCard` 自救逻辑保留）。持久化见 §9。

## 8. 任务拆分

每步都能独立验证、独立回滚。

### P1 后端（约 250 行 + 测试）
- `SessionContext.sessions` 集合；`stopped` 之外的路径不再依赖单值 mutex。
- 新增 `SessionRequest::CloseSession` / `LoadSession` 与两个命令。
- `AcpAgentCapsView` 补 `close_session`。
- `command.rs` 注册、`lib.rs` 的 `generate_handler!` 加两条。
- Rust 测试：多会话集合的增删；close 对不支持能力的 agent 是本地移除；load 走 `session/load`。
- 验证：`cargo test --lib acp`。

### P2 hook 重构（约 700 行）
- 单例状态 → `sessions` Map + `activeKey`；所有 action 改为作用于 activeKey。
- 事件路由表（§4.1）+ starting 阶段的 agentId 兜底 + 启动串行队列。
- 新增 `openSession` / `closeSession` / `stopAgent`。
- 验证：vitest —— 双会话并发流互不串台、stopped 结束该 agent 全部 tab、close 后 tab 消失且不影响兄弟 tab、非活动 tab 的 unread/权限角标计数。

### P3 UI（约 500 行）
- `AcpSessionTabs`（tab 条 + 角标 + `+` 的 agent 菜单）。
- 会话头重排（去掉全局 agent 下拉）。
- 历史面板化。
- 关闭/停止分离 + `ended` 态。
- 验证：fake DOM 渲染测试固定 tab 条结构与角标优先级。

### P4 收尾
- `docs/guides/features/acp_panel_frontend.md` 的状态契约、交互清单、红线全部按新模型重写（这份文档是交接文档，必须同步）。
- i18n 补新文案。
- `docs/releases/unreleased.md` 加条目。

## 9. 本轮不做

- **tab 持久化**（重载后恢复 tab 列表并 `session/load` 重连）。需要处理"后端 runner 还在但前端没有 tab"的旧问题，单独一轮做。
- **`session/list` 合并 agent 侧会话**。它比本地 JSON 更权威（跨进程、跨设备同步），但会把历史从"eShell 的"变成"agent 的"，语义变化大。
- **`session/resume`**（比 `session/load` 更轻的恢复方式）。先只用标准的 load。
- 标题栏 AI 按钮上的待审批红点。
- tab 键盘快捷键（Ctrl+T / Ctrl+Tab）。

## 10. 风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| codex-acp 可能串行 | 同 agent 多 tab 的 turn 互相排队 | 不坏，只是慢；P1 后用同一个探针验一遍，必要时给 agent 加"同时一个 turn"的配置 |
| 单进程承载多会话 | agent 崩溃 → 该 agent 全部 tab 结束 | 明确告知（tab 变 `ended`），不自动重启 |
| 每会话 SDK 初始化约 1s | 新建 tab 有可感知延迟 | 新 tab 先渲染 `starting` 骨架 + 骨架态 composer |
| 前端内存 | N 份 transcript 常驻，长会话更容易卡 | 虚拟化 backlog（现有第 1 条）优先级上升，本轮不做但要在 P2 里避免不必要的整表复制 |
| 探针依赖真实 agent | CI 无法自动化 | 探针保留为手动脚本，不进 `npm test` |

## 11. 验证计划

```bash
node scripts/acp-concurrency-probe.mjs claude-agent-acp   # 复现 §2 结论
npm run test                                             # 前端全量（当前基线 495/44）
cd src-tauri && cargo test --lib acp                     # 后端契约
npm run tauri dev                                        # 冒烟：见下
```

冒烟清单（P3 完成后）：

1. `+` 连开 Codex + Claude 两个 tab → 两个都在跑，互不打断。
2. 同一 agent 开两个 tab，同时发消息 → 两条流各自到达自己的 tab。
3. A tab 跑长 turn 时切到 B tab 发消息 → B 立即响应，A 继续在后台流式；切回 A 看到完整内容。
4. 在活动 tab 触发权限请求 → 切到另一个 tab → 角标是 `1`，切回去能点。
5. 关闭 A tab → B 不受影响；关闭该 agent 最后一个 tab → 进程退出（`acp_agent_list` 的 `running` 变 false）。
6. 历史面板点一条旧记录（该 agent 已在跑）→ 新 tab 打开并回放历史。
7. `⋮ → Stop agent process` → 该 agent 所有 tab 变 `ended`，composer 禁用。

## 12. 实施记录（2026-11-07）

已落地 P1–P3，P4 的文档同步为本次改动的一部分。

**后端（增量，旧前端不改也能跑）**

- `acp_session_close`：发 `session/close`，agent 未声明 `sessionCapabilities.close` 时直接成功返回。
- `acp_session_load`：在**已运行的连接上**重开历史会话（`session/load`）。这是"agent 在跑时打开历史"的前提；不复用 `establish_session`，因为那条路径在 load 失败时会静默降级成新会话，而这里必须报错让前端决定。
- `AcpAgentCapsView.close_session`：把 `session/close` 能力透传给前端。
- 未做：原计划的会话 id 集合（见 §5.1 的说明）。
- 验证：`cargo test --lib` 263 通过。

**前端**

- `useAcpAgent` 重写为多会话：`conversations` + `activeKey`，事件按 `sessionId` 路由、`stopped` 按 `agentId` 结束该 agent 全部会话；同一 agent 的启动用 promise 链串行化。旧的单会话字段（`phase` / `session` / `transcript` / …）保留为「当前会话」的派生值，所以面板可以分步迁移。
- 面板拆成 `AcpSessionTabs` / `AcpTranscript` / `AcpHistoryPanel` + 外壳；`AcpPickers` 里的全局 agent 选择器连同 `locked` 一起删除。
- 历史从"模式"改为浮层，点击记录直接开 tab；`AcpHistoryRecordView`（只读回放）随之删除。
- `AcpOrphanedSessionCard` 删除：残留 runner 现在会被新会话的 `acp_session_new` 直接复用，不再是死路。
- 验证：`npm run test` 512 通过（45 文件）；`npx vite build` 通过。

**偏差**

- 原计划 `⋮` 里保留"停止进程"，实施一致；但**启动失败卡片**额外给了「停止 Agent 进程」，用于 `already has an active session` 这类残留 runner 的场景。
- 原计划 tab 标题取首条用户消息；实施时补了「还没有消息 → 显示『新建会话』」而不是 agent 名，否则同 agent 的两个新 tab 无法区分。
- `turnActive` 仍是每会话字段，另加 `anyTurnActive` 给标题栏/状态栏的全局忙碌指示。

**尚未做**：tab 持久化、`session/list` 合并、`session/resume`、标题栏待审批红点、快捷键（见 §9）。
