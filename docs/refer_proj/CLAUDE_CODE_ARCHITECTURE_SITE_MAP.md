# Claude Code Architecture Site Map

来源：<https://ccb.agent-aura.top/docs/introduction/what-is-claude-code>  
整理日期：2026-04-17

## 目标

这份文档用于把 Claude Code Architecture 站点里的所有功能分类先做成一张总表，方便后续逐项对照，学习哪些设计值得迁移到我们的 agent。

## 总览

- 一级分类共 `10` 个。
- 已整理页面/功能项共 `41` 个。
- `Lsp integration` 当前在导航中可见，但公开页面未正常返回内容，先按“待补链路”记录。

## 一级分类总表

| 一级分类 | 数量 | 关注点 |
| --- | ---: | --- |
| 介绍 | 3 | Claude Code 的定位、逆向分析范围、五层架构总览 |
| 对话是如何运转的 | 3 | Agent loop、多轮会话、流式输出 |
| 工具：AI 的双手 | 5 | Tool 抽象、Shell、文件、搜索、任务管理 |
| 上下文工程 | 4 | System Prompt、项目记忆、token 预算、压缩 |
| 多 Agent 协作 | 3 | 子 Agent、协调者/蜂群、worktree 隔离 |
| 可扩展性 | 4 | MCP、Hooks、Skills、自定义 Agent |
| 安全与权限 | 5 | 权限模型、沙箱、Plan Mode、Auto Mode |
| 揭秘：隐藏功能与内部机制 | 9 | flags、A/B、内部身份门控、调试与彩蛋 |
| 隐藏功能详解 | 1 | Tier3 stubs 汇总 |
| 基础设施与依赖 | 4 | 自动更新、LSP、外部依赖、遥测审计 |

## 分类明细

### 1. 介绍

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| 为什么写这份白皮书 | 说明逆向工程的目标、范围和分析方法，属于总导读页面。 | <https://ccb.agent-aura.top/docs/introduction/why-this-whitepaper> |
| 什么是 Claude Code | 定义它是 terminal-native agentic coding system，核心能力是读代码、改文件、跑命令、调试程序。 | <https://ccb.agent-aura.top/docs/introduction/what-is-claude-code> |
| 架构全景 | 用五层架构解释 Claude Code，从交互层一路落到 API/基础设施层。 | <https://ccb.agent-aura.top/docs/introduction/architecture-overview> |

### 2. 对话是如何运转的

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| Agentic Loop：AI 自主循环的核心机制 | 解释 query loop 状态机，包含流式请求、工具调用、错误恢复和终止条件。 | <https://ccb.agent-aura.top/docs/conversation/the-loop> |
| 多轮对话管理 | 解释 QueryEngine 的会话状态机、transcript 持久化、成本跟踪、模型切换。 | <https://ccb.agent-aura.top/docs/conversation/multi-turn> |
| 流式响应机制 | 解释 SSE 按 token 输出的“打字机效果”和用户等待体验优化。 | <https://ccb.agent-aura.top/docs/conversation/streaming> |

### 3. 工具：AI 的双手

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| 工具系统设计 | 总览 Tool 抽象、注册机制、统一调用链、渲染与 50+ 内置工具协同。 | <https://ccb.agent-aura.top/docs/tools/what-are-tools> |
| 命令执行工具 | Shell/Bash 工具的只读判定、AST 安全解析、后台化、输出截断。 | <https://ccb.agent-aura.top/docs/tools/shell-execution> |
| 文件操作工具 | FileRead、FileEdit、FileWrite 的缓存、原子写入、编辑安全和快照机制。 | <https://ccb.agent-aura.top/docs/tools/file-operations> |
| 搜索与导航工具 | Glob/Grep/ripgrep 驱动的代码检索和代码库定位能力。 | <https://ccb.agent-aura.top/docs/tools/search-and-navigation> |
| 任务管理系统 | TodoWrite + Tasks 双轨任务系统，覆盖依赖、认领、验证推动。 | <https://ccb.agent-aura.top/docs/tools/task-management> |

### 4. 上下文工程

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| System Prompt 动态组装 | 多来源上下文如何拼成缓存友好的 system prompt，包括 CLAUDE.md 多级合并。 | <https://ccb.agent-aura.top/docs/context/system-prompt> |
| 项目记忆系统 | 文件级持久化记忆、MEMORY.md 索引、分类法与智能召回。 | <https://ccb.agent-aura.top/docs/context/project-memory> |
| Token 预算管理 | 200K 窗口预算、截断链路、缓存优化与自动压缩触发。 | <https://ccb.agent-aura.top/docs/context/token-budget> |
| 上下文压缩 | Session Memory、摘要压缩、MicroCompact 三层压缩策略和边界控制。 | <https://ccb.agent-aura.top/docs/context/compaction> |

### 5. 多 Agent 协作

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| 子 Agent 机制 | AgentTool 执行链、进程 fork、prompt cache 共享、结果回传格式。 | <https://ccb.agent-aura.top/docs/agent/sub-agents> |
| 协调者与蜂群模式 | Coordinator/Worker/Swarm 的多 Agent 编排、任务分配、通信协议。 | <https://ccb.agent-aura.top/docs/agent/coordinator-and-swarm> |
| Worktree 隔离 | 用 Git worktree 为子 Agent 提供隔离工作区与生命周期清理。 | <https://ccb.agent-aura.top/docs/agent/worktree-isolation> |

### 6. 可扩展性

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| MCP 协议 | 连接管理、工具发现、认证状态机、缓存策略和权限链路接入。 | <https://ccb.agent-aura.top/docs/extensibility/mcp-protocol> |
| Hooks 生命周期钩子 | 27 种事件、6 种 hook 类型、同步/异步协议、条件匹配和拦截能力。 | <https://ccb.agent-aura.top/docs/extensibility/hooks> |
| Skills 技能系统 | 从磁盘加载、frontmatter、条件激活、inline/fork 双模式到远程技能加载。 | <https://ccb.agent-aura.top/docs/extensibility/skills> |
| 自定义 Agent | Markdown 驱动的 Agent 定义、三种加载来源、工具过滤与 AgentTool 联动。 | <https://ccb.agent-aura.top/docs/extensibility/custom-agents> |

### 7. 安全与权限

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| AI 安全至关重要 | 解释 Claude Code 的威胁模型、风险边界与纵深防御思想。 | <https://ccb.agent-aura.top/docs/safety/why-safety-matters> |
| 权限模型 | Allow/Ask/Deny 三级权限体系，含多来源规则优先级与拒绝追踪。 | <https://ccb.agent-aura.top/docs/safety/permission-model> |
| 沙箱机制 | 沙箱启用条件、默认限制、平台差异以及与权限系统的联动。 | <https://ccb.agent-aura.top/docs/safety/sandbox> |
| 计划模式 | 先看后做的安全模式，覆盖模式切换、计划持久化和审批流程。 | <https://ccb.agent-aura.top/docs/safety/plan-mode> |
| Auto Mode | transcript classifier 驱动的自动权限决策与危险权限剥离。 | <https://ccb.agent-aura.top/docs/safety/auto-mode> |

### 8. 揭秘：隐藏功能与内部机制

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| 三层门禁系统 | 构建时 feature flag、运行时 GrowthBook、身份层 USER_TYPE 三层发布门控。 | <https://ccb.agent-aura.top/docs/internals/three-tier-gating> |
| 88 个 Feature Flags | 构建期 88+ flag 的分类、编译期删除与隐藏功能门控。 | <https://ccb.agent-aura.top/docs/internals/feature-flags> |
| GrowthBook A/B 测试体系 | 运行时 feature 发布、用户分桶、渐进式灰度和实验命名体系。 | <https://ccb.agent-aura.top/docs/internals/growthbook-ab-testing> |
| GrowthBook 适配器 | 通过环境变量接自定义 GrowthBook 服务端，远程控制 feature 默认值。 | <https://ccb.agent-aura.top/docs/internals/growthbook-adapter> |
| 自定义 Sentry 错误上报配置 | 用环境变量接入自托管或 Cloud Sentry。 | <https://ccb.agent-aura.top/docs/internals/sentry-setup> |
| 未公开功能巡礼 | 汇总 8 个代表性隐藏能力，用于理解产品未来方向。 | <https://ccb.agent-aura.top/docs/internals/hidden-features> |
| Ant 特权世界 | Anthropic 内部身份 `ant` 下开放的专属工具、命令、API 和代号体系。 | <https://ccb.agent-aura.top/docs/internals/ant-only-world> |
| Debug 模式 | 用 VS Code attach 调试 CLI 运行时。 | <https://ccb.agent-aura.top/docs/features/debug-mode> |
| Buddy 宠物系统 | `/buddy` 虚拟宠物伴侣，属于交互体验层彩蛋/情感化设计。 | <https://ccb.agent-aura.top/docs/features/buddy> |

### 9. 隐藏功能详解

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| Tier3 stubs | 汇总低优先级、纯 stub、内部基础设施或极低引用的 feature 清单。 | <https://ccb.agent-aura.top/docs/features/tier3-stubs> |

### 10. 基础设施与依赖

| 页面 | 功能整理 | 备注 |
| --- | --- | --- |
| Auto updater | 多安装类型自动更新、轮询检查、版本门控、回滚和原生安装器。 | <https://ccb.agent-aura.top/docs/auto-updater> |
| Lsp integration | 导航中存在，但公开页当前未返回有效正文，先记为待补。 | <https://ccb.agent-aura.top/docs/lsp-integration> |
| External dependencies | 列出真实远程依赖：Anthropic API、Bedrock、Vertex、OAuth、MCP Proxy、Web Search、GCS 等。 | <https://ccb.agent-aura.top/docs/external-dependencies> |
| Telemetry remote config audit | 审计 Datadog、事件日志、GrowthBook、远程设置、OpenTelemetry 等遥测与配置下发。 | <https://ccb.agent-aura.top/docs/telemetry-remote-config-audit> |

## 值得优先学习的设计主题

按“对我们的 agent 最可能直接产生改进”的优先级，建议先看这几组：

1. 工具系统：先读 Tool 抽象、Shell、文件、搜索、任务管理。
2. 安全体系：重点读权限模型、沙箱、Plan Mode、Auto Mode。
3. 上下文工程：重点读 System Prompt、项目记忆、token 预算、压缩。
4. 多 Agent：重点读子 Agent、协调者/蜂群、worktree 隔离。
5. 可扩展性：重点读 Skills、Hooks、MCP、自定义 Agent。

## 对我们后续改造最有价值的能力清单

- 统一的 Tool 抽象层，而不是“命令执行能力”的松散堆叠。
- 任务管理显式化，让 agent 有可见的分步执行状态。
- 上下文预算和压缩机制，避免长会话后质量塌缩。
- 项目级长期记忆，而不是只依赖当前会话消息。
- 权限模型、沙箱和计划模式的组合式安全设计。
- 子 Agent + 隔离工作区，用于并行任务和风险隔离。
- MCP、Hooks、Skills 这一整套可扩展接口。
- 自动更新、遥测、feature flag、远程配置这些“运维层能力”。

## 后续建议

下一步可以按这份清单继续做第二层整理：为每个分类提炼“设计原则 + 运行机制 + 可迁移实现点 + 我们当前差距”。
