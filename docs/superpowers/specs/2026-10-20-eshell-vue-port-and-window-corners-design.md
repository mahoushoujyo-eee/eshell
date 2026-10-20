# 从 eshell-vue 移植后端改动 + 窗口圆角

日期：2026-10-20
状态：已确认，待实现

## 背景

`d:\cctest\eshell-vue` 是本项目的 Vue 3 + Pinia 移植版，最近四个提交对后端和 ACP 面板做了改动。本次把这批改动里**有价值的部分**搬回 `d:\cctest\eshell`（React 版，本仓库），并顺带补上 Linux / macOS 的窗口圆角。

源提交（eshell-vue）：

| commit | 内容 | 本次是否搬 |
| --- | --- | --- |
| `00290a3` | 新增 `acp_runtime_env` 命令探测 Node.js；前端加 `AcpEnvWarningCard`；报错卡片重做；失败上报去重 | 是（前后端都搬） |
| `363e1d8` | 只刷 `Cargo.lock`（tauri 2.11.6→2.12.4 等） | 否 |
| `0d60444` | 删死代码：`Connection::disconnect()`、`jump_connection()`、glob re-export、6 处未用 import | 是（仅这边确实没人用的部分） |
| `796a928` | 全项目注释英文→中文并压缩，净减约 3100 行，121 个文件全动 | 否 |

**不搬 796a928 的原因**：本仓库是开源仓库，注释统一为英文；把 121 个 Rust 文件的注释换成中文属于独立的风格决策，不混进这次功能移植。

## 范围

三块互不依赖，按 A → B → C 顺序实现，每块各自验证。

### A. 后端移植（功能增量 + 死代码清理）

**契约影响：只增不改。** 现有 Tauri 命令名与参数一个都不动，因此 React 前端不跟着改也不会坏 —— 这是"没有不兼容"的结论。

新增 `src-tauri/src/domain/agent/service/runtime_env.rs`：

- `NODE_COMMAND`：Windows 为 `node.exe`，其他平台为 `node`；`NPX_COMMAND`：Windows 为 `npx.cmd`，其他平台为 `npx`。Windows 上必须按真名探，因为 npm 装出来的 launcher 是 `.cmd`，`CreateProcess` 认不了无扩展名的形式。
- `probe_tool(command)`：跑 `<command> --version`，stdin 置 `Stdio::null()`（不给会一直等 stdin）；spawn 成功即 `found: true`，`version` 取 stdout 第一行非空字符串；spawn 失败为 `found: false`、`version: None`。
- `probe()`：`tokio::join!` 并发探两个工具，`ok = node.found && npx.found`。
- 两个单测：不存在的可执行文件报 missing；两个探针各自报告自己的命令名。

改动：

- `domain/agent/model/view.rs`：加 `AcpToolProbeView { found, command, version: Option<String> }`（`version` 为 `None` 时跳过序列化）与 `AcpRuntimeEnvView { ok, node, npx }`，两者 `#[serde(rename_all = "camelCase")]`。
- `domain/agent/model/mod.rs`：导出上述两个类型。
- `domain/agent/service/mod.rs`：`pub(crate) mod runtime_env;`。
- `domain/agent/command.rs`：加 `acp_runtime_env()`，返回 `Ok(runtime_env::probe().await)`。
- `lib.rs`：`generate_handler!` 里注册 `acp_runtime_env`。

死代码清理（只删本仓库确实无调用方的）：

- `Connection::disconnect()`、`jump_connection()`。**`jump` 字段保留** —— 它是跳板机 `Arc<Connection>` 的唯一持有者，删掉会让跳板连接在 `connect()` 返回瞬间被 `Drop` 拆掉。
- `app_update/mod.rs`、`ssh/model/mod.rs` 的 glob re-export（消费者都走显式的 `model::` 路径）。
- 6 处未使用的 import。

验证：`cargo check` + `cargo test`。

### B. 前端移植（Node 环境提示 + 报错卡片重做 + 失败去重）

- `src/lib/tauri-api.js`：加 `acpRuntimeEnv: () => invoke("acp_runtime_env")`。
- `src/hooks/useAcpAgent.js`：
  - 新增 `runtimeEnv` 状态、`missingEnvTools(env)` 辅助、`refreshRuntimeEnv()`。探测抛异常时 `runtimeEnv = null`；**只在 `ok` 由真翻假的那一次**推一条 `warning` / `env-missing` 通知（detail 为缺失工具名），用 `lastEnvOk` 记住上次结论，避免每开一次面板弹一次。
  - 新增 `reportFailure(code, err)`：推 error 通知并记时间戳；`FAILURE_DEDUPE_MS = 5000`。现有 12 处 `pushNotice("error", ...)` 改调它 —— 这是"报错重复了"的修法。
  - AI 面板打开时，与 `refreshAgents()` 一起调 `refreshRuntimeEnv()`。
- `src/components/panels/AcpAgentPanel.jsx`：
  - 重写 `NoticeRow`：
    - `NOTICE_COPY` 映射 code → `{ title, body }`；`body: null` 表示"正文就是原始报错"。
    - 图标 chip + 背后一团同色环境光（`color-mix` + `blur`）+ 同色系细描边，与 `UiNoticeStack` 同一套视觉；正文用等宽字体（原始报错要方便照着搜、照着念）。
    - 正文超 220 字折叠，出「展开详情」；error 且有正文时出复制按钮（复制 `标题: 正文`，成功后 1.6 秒内显示打勾）；`env-missing` 换成「去下载」按钮（`openUrl` 打开 nodejs.org）。
    - 没有正文的非 error 通知退化成一行居中灰字，不画卡片 —— 卡片有描边和底色，一行提示要的是完全不打断阅读。
  - 新增 `src/components/ai/AcpEnvWarningCard.jsx`：标题 + 说明 + 工具清单（缺失显示「未找到」，已装显示版本）+「前往下载 Node.js」「重新检测」两个按钮 + 网址一行。
  - 挂载两处，与 Vue 版一致：未就绪且转写为空时的启动区，以及已有转写时的转写上方。**启动失败后卡片保留** —— 报错行解释"发生了什么"，卡片给"接下来怎么办"。
- `src/lib/i18n.js`：加 37 条中文。

验证：`npm test`，并新增 notice 文案映射与去重的单测。

### C. 窗口圆角（只动 Linux / macOS）

Windows 保持现状（Windows 11 原生圆角 + 系统投影），完全不碰。

**两个已确认的 Tauri 事实**（均从本地 crate 源码核对）：

1. 平台配置走 JSON Merge Patch（RFC 7396），**数组整体替换**，不是逐项合并。
2. `transparent` 只有 builder API，没有运行时 `set_transparent`，所以只能写在配置里。

改动：

- 新增 `src-tauri/tauri.linux.conf.json` 与 `src-tauri/tauri.macos.conf.json`，各带**完整的 window 对象**加 `"transparent": true`；macOS 那份另加 `"app": { "macOSPrivateApi": true }`（不加的话 macOS 上透明不生效）。
  - 因为数组整体替换，window 对象会出现三份，有漂移风险。加一个小测试守住：读三份配置，断言平台那份的 window 对象除 `transparent` 外与基准逐字段一致。
- `src-tauri/Cargo.toml`：tauri features 加 `macos-private-api`（`macOSPrivateApi` 需要它）。
- `src-tauri/src/boot.rs`：`reveal()` 不再给窗口刷底色 —— 透明窗口刷底色就是把圆角填成方的。按平台判断，Windows 保持现状。
- `index.html`：启动 splash 在这些平台加同样的圆角；`html` / `body` 的底色改为透明，否则圆角会被填成方的。平台属性在 `<head>` 那段内联脚本里就写上 —— 窗口是 `visible: false`，真正可见时 JS 早已执行完，不会闪方角。
- `src/index.css`：这两个平台下 `body` 透明；底色从 `body` 挪到 `.app-shell`；未最大化时 `.app-shell` 加 `border-radius: 10px`。
- `src/App.jsx` + `src/components/layout/WindowTitleBar.jsx`：`isMaximized` 从 WindowTitleBar 内部提到 `useWorkbench` 的 UI 片（对应 Vue 版放进 ui store），**只保留一处订阅**；`App.jsx` 用它切换圆角类，最大化时必须去掉圆角（满屏留圆角会在四边留下缺口）。平台探测从 WindowTitleBar 抽到共享 util。

验证：`npm test`；Rust 侧 `cargo check`。圆角本身需要在 Linux / macOS 上实机确认，Windows 上应无任何视觉变化。

## 非目标

- 不搬 `796a928` 的中文注释改写。
- 不刷 `Cargo.lock`。
- 不改 Windows 的窗口外观。
- 不做 Vue 版前端架构（`src/api` 分层、`src/stores` 拆分）的移植 —— 那不在本次"后端"范围内。
