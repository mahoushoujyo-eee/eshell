# eShell 项目开发指南（当前共识版）

> 最后更新：2026-04-01
> 适用范围：`C:\Main\CS\VScode\eshell`

## 1. 项目目标与当前定位

eShell 是一个 **Tauri + React + Rust** 的运维工作台，核心目标是把以下能力串成一条稳定闭环：

1. 连接与交互：SSH / PTY / SFTP
2. 观测与操作：状态查看、脚本执行
3. 智能协助：Ops Agent（ReAct 多轮 + 工具调用 + 审批 + 恢复）

当前阶段重点不是“堆功能”，而是：

1. 保证 ReAct 流程稳定（不提前退出、不丢会话、不假完成）
2. 保证可观测（出现异常时能靠日志快速定位）
3. 保证可维护（大文件持续拆分、模块职责清晰）

## 2. 开发前必须对照的参考项目

实现复杂流程（尤其 Agent 循环、工具协议、审批恢复）时，**必须先对照**：

1. `C:\Main\CS\VScode\eshell\docs\refer_proj`
2. `docs/refer_proj/CLAUDECODE_PROJECT_ANALYSIS.md`
3. `docs/refer_proj/claude-code-main/src/query.ts`
4. `docs/refer_proj/claude-code-main/src/QueryEngine.ts`
5. `docs/refer_proj/claude-code-main/src/Tool.ts`

对照时要看的是“机制”而不是“照抄代码”：

1. 状态迁移是否完整（继续/停止原因是否可解释）
2. 工具调用后是否总能回到回答阶段
3. 审批中断后是否可恢复并延续上下文
4. 日志是否能复原完整链路

## 3. 当前后端架构（已重组）

### 3.1 命令层（Tauri Commands）

- `src-tauri/src/commands/`
- `src-tauri/src/server_ops/commands.rs`

说明：

1. `commands/config.rs`：配置与存储相关命令（ssh/scripts/ai profiles）
2. `commands/ops_agent.rs`：Ops Agent 会话与审批命令
3. `commands/ai.rs`：通用 AI ask
4. `server_ops/commands.rs`：shell/sftp/status/run_script 相关命令

### 3.2 存储层（Storage）

- `src-tauri/src/storage/`

说明：

1. `storage/ssh.rs`：SSH 配置 CRUD
2. `storage/scripts.rs`：脚本 CRUD
3. `storage/ai_profiles.rs`：AI profile/config 与迁移逻辑
4. `storage/io.rs`：通用 JSON 读写
5. `storage/tests.rs`：存储层测试

### 3.3 Ops Agent 层

- `src-tauri/src/ops_agent/`
- `src-tauri/src/ops_agent/service/`

说明：

1. `service/chat.rs`：会话启动/取消
2. `service/react_loop.rs`：ReAct 主循环
3. `service/resolve.rs`：审批 resolve + resume
4. `service/runtime.rs`：run 生命周期
5. `service/helpers.rs`：通用工具函数
6. `service/tests.rs`：回归测试

## 4. 实现与改动的硬性约束

### 4.1 ReAct 链路约束（必须满足）

1. 工具执行后，必须把结果写入消息历史（`Tool` message）
2. 审批动作出现后，必须给前端明确事件和文本反馈
3. 审批通过/拒绝后，必须写回消息，不能“静默结束”
4. 可恢复场景必须确保 resume 仍使用正确会话（session）

### 4.2 会话一致性约束（必须满足）

1. 以当前激活 shell session 为优先上下文
2. resolve 审批时允许显式 session override
3. conversation 绑定 session 漂移时要有日志并纠正

### 4.3 可观测性约束（必须满足）

新增流程时，至少要覆盖以下日志阶段：

1. request_start
2. request_done / request_failed / request_cancelled
3. 关键状态迁移（如 awaiting_approval、resume_started）

日志原则：

1. 能从日志串起单次 run 的完整生命周期
2. 出错时日志内必须有 run_id / conversation_id / step / command 摘要

### 4.4 代码组织约束

1. 避免继续扩大超长文件，优先拆子模块
2. 新增功能按职责落到现有模块，不要堆到入口文件
3. 对外接口保持稳定（尽量不改前端调用契约）

## 5. 测试要求（新增功能必须有）

**硬性要求：任何新增功能或行为变更，都必须补测试。**

最低标准：

1. 至少 1 个“主路径”测试（成功场景）
2. 至少 1 个“失败/边界”测试（异常或回退场景）

建议覆盖维度：

1. 正常执行路径
2. 审批路径（pending/executed/rejected/failed）
3. 会话切换与恢复路径
4. 日志触发关键节点（可通过行为侧验证）

当前命令：

```bash
cd src-tauri
cargo check
cargo test --no-run
```

说明：

1. `cargo test --no-run` 用于快速验证测试可编译
2. 如果本机存在测试运行时依赖问题（如 Windows entrypoint 问题），至少保证 `check + no-run` 全绿，并在 PR/提交说明中写明原因

## 6. 开发流程建议（每次改动按此执行）

1. 先阅读相关模块与 `docs/refer_proj` 对照实现
2. 明确状态机与数据流，再编码
3. 小步提交：先重构再功能，避免一次混入太多风险
4. 增加日志与测试
5. 本地执行 `cargo check`、`cargo test --no-run`
6. 提交时写清：改了什么、为什么、风险点、如何验证

## 7. 高风险坑位提醒

1. “看起来直接退出”不一定是崩溃，可能是进入审批后回合正常结束
2. 会话漂移会导致 pending action 在 UI 侧“看不见”
3. read_shell 命令链可能触发策略拦截，需走审批升级路径
4. 仅 planner 成功不代表闭环完成，必须确保 tool->answer 或 tool->approval->resume

## 8. 变更验收清单（提交前勾选）

- [ ] 是否已对照 `docs/refer_proj` 的对应机制
- [ ] 是否补充了测试（主路径 + 边界/失败）
- [ ] 是否补充/更新关键日志
- [ ] 是否验证会话一致性（尤其审批与恢复）
- [ ] 是否通过 `cargo check`
- [ ] 是否通过 `cargo test --no-run`
- [ ] 是否避免把逻辑继续堆进超长文件

---

如果后续继续演进 Ops Agent，优先级建议：

1. 先补强可观测与状态迁移明确性
2. 再做工具能力扩展
3. 最后再做并发与性能优化
