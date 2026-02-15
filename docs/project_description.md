# eShell 项目描述（基于当前实现与需求约束）

## 1. 项目定位

eShell 是一个面向日常运维场景的桌面化工作台，目标是用一个统一界面完成 SSH 连接管理、终端操作、SFTP 文件管理、状态监控、脚本执行和 AI 运维协同。  
项目整体交互风格参考 FinalShell，技术架构采用 Tauri 2 + React + Rust，强调本地可部署、低资源占用和可扩展的模块化设计。

## 2. 核心目标

1. 提供接近真实 Shell 的交互体验（PTY + xterm.js）。
2. 支持多会话并行，避免不同服务器/标签之间状态串扰。
3. 提供可视化 SFTP 浏览与文件操作能力，覆盖常见运维文件流转。
4. 引入 Ops Agent，实现多轮对话、工具调用与风险操作审批闭环。
5. 保证配置与会话数据本地持久化，便于恢复和后续审计。

## 3. 已实现能力（当前版本）

### 3.1 SSH 与终端
- SSH 配置的增删改查与本地持久化
- 会话列表管理（多标签页）
- PTY 输入/输出与窗口 resize 同步
- 基于 xterm.js 的终端渲染与交互

### 3.2 SFTP 与文件
- 目录列表获取与文件上传/下载
- 目录树与文件区分区展示
- 文件内容读取与编辑弹窗

### 3.3 服务器状态
- CPU、内存、网卡流量、Top 进程、磁盘占用采集
- 缓存 + 周期刷新机制（会话切换时优先显示缓存）

### 3.4 脚本管理
- 脚本定义（名称/路径/命令）管理
- 绑定当前会话执行脚本命令

### 3.5 Ops Agent（AI）
- OpenAI-compatible 接口接入（baseUrl / apiKey / model）
- 多轮会话、会话切换、流式输出
- 工具调用分级：
  - `read_shell`：只读诊断类命令自动执行
  - `write_shell`：进入待审批队列，用户确认后执行
- 工具结果回写对话上下文，形成完整链路

## 4. 技术架构

### 4.1 前端
- React + Vite + Tailwind CSS
- 状态编排集中在 `useWorkbench`，面板组件按职责拆分
- 通过 Tauri `invoke` + 事件监听对接后端命令与流式事件

### 4.2 后端
- Tauri Command 作为 RPC 边界
- Rust 服务模块拆分：`ssh_service`、`storage`、`ops_agent`
- IO/耗时操作通过异步或阻塞线程池执行，降低 UI 阻塞风险

## 5. 数据持久化策略

运行目录下统一使用 `.eshell-data` 本地存储。

- `ssh_configs.json`：SSH 配置
- `scripts.json`：脚本定义
- `ai_profiles.json`：AI Profile
- `ops_agent_conversation_list.json`：会话摘要 + active 会话 + pending actions
- `ops_agent_conversations/<conversationId>.json`：单会话消息明细

补充规则：
- 新会话标题默认 `New Conversation`
- 首条用户消息自动生成标题（前 10 字，超出追加 `...`）
- 兼容旧格式迁移并清理历史文件（如 `ops_agent.json`、`ai_config.json`）

## 6. 接口与交互约束

- 后端能力通过 Tauri commands 暴露，接口文档以 `docs/openapi.yaml` 为基础
- AI 工具执行遵循“可读自动、可写审批”原则
- 流式错误事件必须回传真实 `runId/conversationId`，避免前端状态锁死

## 7. 非功能要求与注意事项

1. 当前本地配置文件默认未加密（包括 SSH 密码、AI Key），仅建议在受控环境使用。
2. 面向生产场景应补充密钥加密存储、审计日志与最小权限控制。
3. 上游模型可能触发配额限制（如 429），需支持快速切换模型/Key。

## 8. 项目价值总结

eShell 将传统“终端 + 文件 + 监控 + 脚本 + AI”分散链路整合为单工作台，核心价值在于：
- 提高运维操作连续性
- 降低多工具切换成本
- 通过 Agent + 审批机制提升执行效率与安全性
