# Ops Agent Layered Architecture

这份文档描述当前 eShell 中 `ops_agent` 的实际分层，并补上最近新增的图片多模态输入与附件存储链路。

参考映射仍然采用“5 层 + 1 个支撑层”的方式：

1. 交互层 `Interaction`
2. 编排层 `Orchestration`
3. 核心循环层 `Core Loop`
4. 工具层 `Tools`
5. 通信层 `Communication`
6. 支撑层 `Infrastructure`

## 1. 当前包结构

```text
src-tauri/src/ops_agent/
├─ application/
│  ├─ mod.rs
│  ├─ attachments.rs
│  ├─ approval.rs
│  ├─ chat.rs
│  ├─ compaction.rs
│  └─ tests.rs
├─ core/
│  ├─ mod.rs
│  ├─ compaction.rs
│  ├─ helpers.rs
│  ├─ llm.rs
│  ├─ prompting.rs
│  ├─ react_loop.rs
│  └─ runtime.rs
├─ domain/
│  ├─ mod.rs
│  └─ types.rs
├─ infrastructure/
│  ├─ mod.rs
│  ├─ attachments.rs
│  ├─ logging.rs
│  ├─ run_registry.rs
│  └─ store.rs
├─ providers/
│  ├─ mod.rs
│  ├─ openai_compat.rs
│  ├─ text_fallback.rs
│  └─ types.rs
├─ tools/
│  ├─ mod.rs
│  └─ shell.rs
├─ transport/
│  ├─ mod.rs
│  ├─ events.rs
│  └─ stream.rs
└─ mod.rs
```

## 2. 分层映射

### 交互层 `Interaction`

职责：

- 接收用户文本、shell 上下文、图片输入
- 展示流式回复、工具状态、审批卡片
- 展示已发送消息中的图片标签并按需查看图片内容

当前实现：

- 前端 UI：`src/components/panels/ai-assistant/*`
- Tauri 命令入口：`src-tauri/src/commands/ops_agent.rs`
- 前端桥接：`src/lib/tauri-api.js`、`src/lib/ops-agent-stream.js`

说明：

- 图片不会先走独立上传服务，而是和一次聊天请求一起通过 `base64` 进入后端。
- 图片查看走单独的读取命令 `ops_agent_get_attachment_content`，避免会话 JSON 内嵌大块二进制数据。

### 编排层 `Orchestration`

职责：

- 会话 CRUD
- 启动 chat run
- 处理审批回调
- 处理手动 compaction
- 处理附件读取这种用例级入口

当前实现：

- `src-tauri/src/ops_agent/application/chat.rs`
- `src-tauri/src/ops_agent/application/approval.rs`
- `src-tauri/src/ops_agent/application/compaction.rs`
- `src-tauri/src/ops_agent/application/attachments.rs`

说明：

- `chat.rs` 现在除了创建/绑定会话、启动 run，还负责把前端传来的图片 payload 先落到附件存储层，再把 `attachmentIds` 写入消息。
- `attachments.rs` 只负责“按附件 id 读取内容给前端预览”这个用例，不参与 ReAct 循环。

### 核心循环层 `Core Loop`

职责：

- Prompt 组装
- LLM 规划与回答
- ReAct loop
- 自动 compaction
- runtime 与取消/重试/结束逻辑

当前实现：

- `src-tauri/src/ops_agent/core/prompting.rs`
- `src-tauri/src/ops_agent/core/llm.rs`
- `src-tauri/src/ops_agent/core/react_loop.rs`
- `src-tauri/src/ops_agent/core/compaction.rs`
- `src-tauri/src/ops_agent/core/runtime.rs`

说明：

- `core/llm.rs` 现在负责把用户消息从“文本 + shellContext + attachmentIds”转换成 provider 需要的图文混合消息。
- 对用户消息来说，真正进入模型上下文的是：
  - 文本请求
  - shell 上下文文本
  - 从本地附件存储层读取后拼成的 `data:` URL 图片内容

### 工具层 `Tools`

职责：

- 工具注册
- 工具契约
- 工具执行
- 审批前后统一封装

当前实现：

- `src-tauri/src/ops_agent/tools/mod.rs`
- `src-tauri/src/ops_agent/tools/shell.rs`

说明：

- 当前仍然以 `shell` 为主，`read_shell` / `write_shell` 只是兼容别名。
- 多模态输入不是工具能力，而是用户消息输入能力，所以不放到 `tools/`。

### 通信层 `Communication`

职责：

- Provider 协议适配
- SSE 流解析
- Tauri 事件发射

当前实现：

- `src-tauri/src/ops_agent/providers/openai_compat.rs`
- `src-tauri/src/ops_agent/providers/text_fallback.rs`
- `src-tauri/src/ops_agent/providers/types.rs`
- `src-tauri/src/ops_agent/transport/events.rs`
- `src-tauri/src/ops_agent/transport/stream.rs`

说明：

- `providers/types.rs` 已从单纯字符串消息升级为可表示图文混合内容的协议模型。
- `openai_compat.rs` 负责把这些内容序列化成 OpenAI 兼容接口可接受的 `messages`。

## 3. 支撑层 `Infrastructure`

职责：

- 会话持久化
- 附件文件持久化
- 调试日志
- 运行注册表

当前实现：

- `src-tauri/src/ops_agent/infrastructure/store.rs`
- `src-tauri/src/ops_agent/infrastructure/attachments.rs`
- `src-tauri/src/ops_agent/infrastructure/logging.rs`
- `src-tauri/src/ops_agent/infrastructure/run_registry.rs`

说明：

- `store.rs` 只保存会话元信息和消息正文；消息里只保留 `attachmentIds`。
- `attachments.rs` 单独管理图片文件和元数据，存储目录是 `.eshell-data/ops_agent_attachments/`。
- `logging.rs` 继续作为跨层共享日志工具，附件保存、读取、删除都写入 `ops_agent_debug.log`。

## 4. 领域层 `Domain`

职责：

- 定义稳定的数据结构
- 承载跨层共享的纯数据模型

当前实现：

- `src-tauri/src/ops_agent/domain/types.rs`

当前关键模型：

- `OpsAgentMessage`
- `OpsAgentConversation`
- `OpsAgentChatInput`
- `OpsAgentImageAttachmentInput`
- `OpsAgentAttachmentContent`

说明：

- `OpsAgentMessage` 新增 `attachmentIds`
- `OpsAgentChatInput` 新增 `imageAttachments`
- 前端上传的图片 payload 与持久化后的附件引用被明确区分开

## 5. 图片多模态链路

### 发送链路

1. 前端在 `AiComposer` 中选择图片文件。
2. 前端把图片转成 `base64`，作为 `imageAttachments` 一起传给 `ops_agent_chat_stream_start`。
3. `application/chat.rs` 调用 `infrastructure/attachments.rs` 保存图片文件和元数据。
4. 会话消息只保存 `attachmentIds`，不保存图片原始内容。
5. `core/llm.rs` 在构造 provider 消息时，按 `attachmentIds` 回读本地图片并组装成图文混合消息。

### 查看链路

1. 前端消息区显示图片标签，而不是直接把图片内容内嵌在会话 JSON 中。
2. 用户点击标签后，前端调用 `ops_agent_get_attachment_content`。
3. `application/attachments.rs` 从附件存储层读取 `base64` 和 `contentType`。
4. 前端用返回内容构造图片预览弹层。

### 清理链路

- 删除会话时，会删除该会话引用到的附件文件。
- 历史压缩时，如果旧消息被压缩掉且附件不再被保留消息引用，也会删除附件文件。

## 6. 持久化布局

当前 `.eshell-data/` 里的 Ops Agent 相关内容：

```text
.eshell-data/
├─ ops_agent_conversation_list.json
├─ ops_agent_conversations/
│  └─ <conversation-id>.json
├─ ops_agent_attachments/
│  ├─ <attachment-id>.bin
│  └─ <attachment-id>.json
└─ ops_agent_debug.log
```

约束：

- 会话 JSON 中只保存消息文本、shell 上下文、`attachmentIds`
- 图片原始内容只在附件目录里保存
- 前端查看图片时按需读取，不依赖会话文件内嵌

## 7. 日志分层

当前建议使用的日志前缀：

- `application.*`
- `infrastructure.*`
- `transport.*`

图片链路新增重点前缀：

- `application.attachments.read`
- `infrastructure.attachments.saved`
- `infrastructure.attachments.loaded`
- `infrastructure.attachments.deleted`

这些日志和已有的 `chat.*`、`ai.provider.*`、`compact.*` 结合后，已经可以把“上传图片 -> 落盘 -> 进入模型 -> 点击查看 -> 删除清理”整条链路串起来排查。

## 8. 依赖方向

建议继续保持下面这个方向，不要反转：

```text
frontend / commands
  -> application
  -> core
  -> tools
  -> providers + transport
  -> infrastructure
  -> domain
```

具体约束：

- `application` 可以依赖 `core/tools/infrastructure/domain`
- `core` 可以依赖 `providers/transport/infrastructure/domain`
- `tools` 不要依赖 `application`
- `providers` 不要依赖 `application/tools/store`
- `domain` 只放数据结构和纯规则

## 9. 当前整理解决了什么

- `ops_agent` 根目录不再堆所有职责
- provider 适配和 ReAct 核心循环彻底拆开
- 会话持久化与附件持久化拆开
- 图片内容不再污染会话 JSON
- 前端查看图片走按需读取，而不是全量加载
- 日志覆盖从“纯文本聊天”扩展到“图文输入 + 本地附件持久化”

## 10. 下一步建议

如果继续整理，我建议按这个顺序做：

1. 把 `tools/shell.rs` 再拆成 `validator / risk / executor`
2. 把 `core/llm.rs` 再拆成 `planner / answerer / history_serializer`
3. 为附件增加大小限制、数量限制和更明确的清理策略
4. 如果后续要支持非图片附件，再单独抽一个 `attachments/` 子域，而不是把所有类型继续塞回 `types.rs`
