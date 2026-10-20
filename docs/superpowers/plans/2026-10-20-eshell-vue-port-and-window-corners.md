# eshell-vue 后端移植 + 窗口圆角 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 eshell-vue 的 Node.js 运行环境探测、报错卡片重做与死代码清理搬进本仓库，并给 Linux / macOS 的窗口外框补上圆角。

**Architecture:** 三块互不依赖，按 A → B → C 顺序做。A 是纯 Rust 增量（新命令 `acp_runtime_env` + 删死代码），前端契约只增不改。B 把新命令接进 React 的 ACP 面板：环境探测 → 常驻警告卡；转写通知行重做成标题/正文分离的卡片；失败上报加 5 秒去重。C 用 Tauri 平台专属配置在 Linux / macOS 上开窗口透明，配合 CSS 圆角，Windows 完全不动。

**Tech Stack:** Rust + Tauri v2（src-tauri）、React 19 + Tailwind v4（src/）、Vitest + 自带的 fake DOM（src/test/）。

## Global Constraints

- 注释一律英文，与本仓库现有风格一致（**不搬** eshell-vue `796a928` 的中文注释改写）。
- 不刷 `Cargo.lock`（**不搬** `363e1d8`）。
- 现有 Tauri 命令名与参数一个都不改；`acp_runtime_env` 是纯新增。
- Windows 的窗口外观不做任何改动。
- 前端文案走 `src/lib/i18n.js` 的 `zhMessages`，key 保持英文原文。
- 测试命令：Rust `cargo test`（在 `src-tauri/` 下）；前端 `npm test`（在仓库根）。
- 分支：全部改动做在 `feat/eshell-vue-port-and-window-corners` 上，不直接提交 `master`。

---

### Task 0: 建分支

**Files:** 无

- [ ] **Step 1: 建并切到工作分支**

```bash
git checkout -b feat/eshell-vue-port-and-window-corners
```

- [ ] **Step 2: 确认干净起点**

Run: `git status --short`
Expected: 只有 `?? docs/superpowers/` 两处未跟踪（spec 与 plan 本身）

---

### Task 1: 后端 —— `acp_runtime_env` 命令

**Files:**
- Create: `src-tauri/src/domain/agent/service/runtime_env.rs`
- Modify: `src-tauri/src/domain/agent/service/mod.rs`
- Modify: `src-tauri/src/domain/agent/model/view.rs`（在文件末尾追加两个结构体）
- Modify: `src-tauri/src/domain/agent/command.rs`（在 `acp_agent_list` 之前插入新命令）
- Modify: `src-tauri/src/lib.rs:114`（在 `acp_agent_list` 之前注册）

**Interfaces:**
- Consumes: `crate::domain::agent::model::view::{AcpRuntimeEnvView, AcpToolProbeView}`
- Produces:
  - `pub async fn probe() -> AcpRuntimeEnvView`（`service::runtime_env`）
  - `#[tauri::command] pub async fn acp_runtime_env() -> Result<AcpRuntimeEnvView, String>`
  - 序列化形状：`{ ok: bool, node: { found: bool, command: string, version?: string }, npx: { … } }`

注意 `model/mod.rs` 用的是 glob 再导出（`pub use view::*;`），所以新类型不用再手动导出。

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/domain/agent/service/runtime_env.rs`，先只写测试与常量：

```rust
use std::process::Stdio;

use tokio::process::Command;

use crate::domain::agent::model::view::{AcpRuntimeEnvView, AcpToolProbeView};

const NODE_COMMAND: &str = if cfg!(windows) { "node.exe" } else { "node" };

// npx is a `.cmd` on Windows, so it has to be probed by its real name.
const NPX_COMMAND: &str = if cfg!(windows) { "npx.cmd" } else { "npx" };

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_executable_is_reported_missing() {
        let probe = probe_tool("eshell-no-such-tool-xyz").await;
        assert!(!probe.found);
        assert_eq!(probe.version, None);
        assert_eq!(probe.command, "eshell-no-such-tool-xyz");
    }

    #[tokio::test]
    async fn probes_report_their_own_command() {
        let view = probe().await;
        assert_eq!(view.node.command, NODE_COMMAND);
        assert_eq!(view.npx.command, NPX_COMMAND);
        assert_eq!(view.ok, view.node.found && view.npx.found);
    }
}
```

同时在 `src-tauri/src/domain/agent/service/mod.rs` 末尾加一行：

```rust
pub(crate) mod runtime_env;
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib runtime_env`
Expected: 编译失败 —— `probe_tool` / `probe` / `AcpRuntimeEnvView` / `AcpToolProbeView` 都还不存在

- [ ] **Step 3: 加视图类型**

在 `src-tauri/src/domain/agent/model/view.rs` **文件末尾**追加：

```rust
/// One probed toolchain binary reported by `acp_runtime_env`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolProbeView {
    pub found: bool,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Node.js toolchain the built-in agents need, probed on demand.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRuntimeEnvView {
    pub ok: bool,
    pub node: AcpToolProbeView,
    pub npx: AcpToolProbeView,
}
```

- [ ] **Step 4: 实现探针**

在 `runtime_env.rs` 的 `use` 之后、`#[cfg(test)]` 之前插入：

```rust
async fn probe_tool(command: &str) -> AcpToolProbeView {
    let output = Command::new(command)
        .arg("--version")
        // Without a null stdin the child blocks waiting for input forever.
        .stdin(Stdio::null())
        .output()
        .await;

    match output {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToString::to_string);
            AcpToolProbeView {
                found: true,
                command: command.to_string(),
                version,
            }
        }
        Err(_) => AcpToolProbeView {
            found: false,
            command: command.to_string(),
            version: None,
        },
    }
}

pub async fn probe() -> AcpRuntimeEnvView {
    let (node, npx) = tokio::join!(probe_tool(NODE_COMMAND), probe_tool(NPX_COMMAND));
    AcpRuntimeEnvView {
        ok: node.found && npx.found,
        node,
        npx,
    }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib runtime_env`
Expected: 2 passed

- [ ] **Step 6: 暴露命令**

在 `src-tauri/src/domain/agent/command.rs` 的 `use crate::domain::agent::service::acp_client::AcpSessionRunner;` 之后加：

```rust
use crate::domain::agent::service::runtime_env;
```

并在 `#[tauri::command] pub async fn acp_agent_list` **之前**插入：

```rust
/// Probes the local Node.js toolchain the built-in agents are launched through.
#[tauri::command]
pub async fn acp_runtime_env() -> Result<crate::domain::agent::model::AcpRuntimeEnvView, String> {
    Ok(runtime_env::probe().await)
}
```

- [ ] **Step 7: 注册命令**

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里，`domain::agent::command::acp_agent_list,` **之前**插入一行：

```rust
            domain::agent::command::acp_runtime_env,
```

- [ ] **Step 8: 编译 + 全量测试**

Run: `cd src-tauri && cargo test`
Expected: 全部通过（含新增 2 个）

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/domain/agent/service/runtime_env.rs \
        src-tauri/src/domain/agent/service/mod.rs \
        src-tauri/src/domain/agent/model/view.rs \
        src-tauri/src/domain/agent/command.rs \
        src-tauri/src/lib.rs
git commit -m "feat(acp): probe the local Node.js toolchain

Adds the acp_runtime_env command so the panel can tell the user that the
built-in agents cannot start before Node.js is installed, instead of
leaving them to guess from a spawn error.

Purely additive: no existing command name or payload changed."
```

---

### Task 2: 后端 —— 删死代码

**Files:**
- Modify: `src-tauri/src/domain/ssh/service/transport.rs:287,301`
- Modify: `src-tauri/src/domain/ssh/model/mod.rs`
- Modify: `src-tauri/src/domain/app_update/mod.rs`
- Modify: `src-tauri/src/domain/app_update/tests.rs:5`
- Modify: `src-tauri/src/domain/config/tests.rs:7`

**Interfaces:** 无新增；`Connection` 的公开方法面变小。

**不要删 `Connection` 的 `jump` 字段。** 编译器会报它 "never read"，但它是跳板机 `Arc<Connection>` 的唯一持有者 —— 删掉后跳板连接会在 `connect()` 返回的瞬间被 `Drop` 拆掉，跳板功能静默失效。这一条在 eshell-vue 的同一个提交里有记录。

- [ ] **Step 1: 删两个没人调用的方法**

在 `src-tauri/src/domain/ssh/service/transport.rs` 删掉这两段（含各自的文档注释）：

```rust
    pub fn jump_connection(&self) -> Option<&Arc<Connection>> { … }
```

```rust
    pub async fn disconnect(&self) { … }
```

（`spawn_graceful_disconnect` 保留 —— 它被 `Drop` 用到。）

- [ ] **Step 2: 删没人用的再导出**

`src-tauri/src/domain/ssh/model/mod.rs`：删掉 `pub use session_model::*;`，**保留** `pub use model::*;`。

`src-tauri/src/domain/app_update/mod.rs`：删掉末尾的 `pub use model::{ReleaseAsset, ReleaseCheck};`。

依据：全部消费者都走显式路径（`ssh::model::session_model::X`、`app_update::model::X`）。

- [ ] **Step 3: 删两个没用的 import**

`src-tauri/src/domain/config/tests.rs:7`：删掉整行 `use crate::domain::scripts::model::ScriptInput;`。

`src-tauri/src/domain/app_update/tests.rs:5`：把 `current_version,` 从 import 列表里去掉，变成：

```rust
use crate::domain::app_update::service::{
    file_name_of, is_newer, normalize_version, platform_key,
};
```

（`current_version` 函数本身在 `command.rs` / `service.rs` 里还在用，不要删函数。）

- [ ] **Step 4: 编译 + 全量测试**

Run: `cd src-tauri && cargo test`
Expected: 全部通过，且上述 5 处不再出现在 warning 里

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/domain/ssh/service/transport.rs \
        src-tauri/src/domain/ssh/model/mod.rs \
        src-tauri/src/domain/app_update/mod.rs \
        src-tauri/src/domain/app_update/tests.rs \
        src-tauri/src/domain/config/tests.rs
git commit -m "refactor(ssh): drop dead connection methods and unused re-exports

Connection::disconnect and jump_connection have no callers, and every
consumer reaches the session types through explicit paths, so the two
glob re-exports are dead too.

The `jump` field stays: it is the only owner of the jump host's
Arc<Connection>, and dropping it tears the jump connection down the
moment connect() returns."
```

---

### Task 3: 前端 —— api 层 + 环境探测 + 失败去重

**Files:**
- Modify: `src/lib/tauri-api.js`（`acpAgentList` 之前加一行）
- Modify: `src/hooks/useAcpAgent.js`
- Test: `src/hooks/useAcpAgent.test.js`（新建）

**Interfaces:**
- Consumes: `api.acpRuntimeEnv()` → `{ ok, node: {found, command, version?}, npx: {…} }`
- Produces（`useAcpAgent()` 的返回值新增三项）：
  - `runtimeEnv: object | null`
  - `envMissing: boolean`
  - `refreshRuntimeEnv: () => Promise<object | null>`
  - 内部：`reportFailure(code, err)`、`failureAlreadyReported()`（`FAILURE_DEDUPE_MS = 5000`）

- [ ] **Step 1: 写失败的测试**

新建 `src/hooks/useAcpAgent.test.js`：

```js
/**
 * The Node.js probe and the failure dedupe are both pure state machines
 * hanging off `acp_runtime_env` and the notice stream, so they are tested
 * through the hook's public surface rather than the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { renderHook, act } from "../test/react-render.js";
import { useAcpAgent } from "./useAcpAgent.js";

beforeEach(() => {
  invoke.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime env probe", () => {
  it("only pushes the env-missing notice on the transition into missing", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "acp_runtime_env") {
        return { ok: false, node: { found: false, command: "node" }, npx: { found: true, command: "npx", version: "10.0.0" } };
      }
      return [];
    });

    const { result } = renderHook(() => useAcpAgent());

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });
    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    const envNotices = result.current.transcript.filter((entry) => entry.code === "env-missing");
    expect(envNotices).toHaveLength(1);
    expect(envNotices[0].detail).toBe("node");
    expect(result.current.envMissing).toBe(true);
  });

  it("leaves runtimeEnv null when the probe throws", async () => {
    invoke.mockRejectedValue(new Error("no tauri runtime"));
    const { result } = renderHook(() => useAcpAgent());

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    expect(result.current.runtimeEnv).toBeNull();
    expect(result.current.envMissing).toBe(false);
  });
});
```

`src/test/react-render.js` 目前只导出 `render` 与 `fireClick`，先补一个 `renderHook`：import 区加 `import { createElement } from "react";`，然后在文件末尾追加：

```js
/** Mounts a hook through a probe component and exposes its latest return value. */
export async function renderHook(hook) {
  const ref = { current: null };
  function Probe() {
    ref.current = hook();
    return null;
  }
  const mounted = await render(createElement(Probe));
  return { ...mounted, result: ref };
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/hooks/useAcpAgent.test.js`
Expected: FAIL —— `result.current.refreshRuntimeEnv is not a function`

- [ ] **Step 3: api 层加一行**

在 `src/lib/tauri-api.js` 的 `acpAgentList:` **之前**插入：

```js
  // Probes the Node.js toolchain the built-in agents are launched through.
  acpRuntimeEnv: () => invoke("acp_runtime_env"),
```

- [ ] **Step 4: hook 里加状态与去重**

在 `src/hooks/useAcpAgent.js` 里，`const [shellContext, setShellContext] = useState(null);` 附近加：

```js
  const [runtimeEnv, setRuntimeEnv] = useState(null);
```

在模块顶部（`const STREAM_EVENT = "acp-agent-stream";` 附近）加：

```js
// A failing command often surfaces twice (the stream event and the command's
// own rejection), so identical failures inside this window are reported once.
const FAILURE_DEDUPE_MS = 5000;
```

在 `pushNotice` 之后加：

```js
  const failureReportedAtRef = useRef(0);

  const reportFailure = useCallback(
    (code, err) => {
      pushNotice("error", code, err);
      failureReportedAtRef.current = Date.now();
    },
    [pushNotice],
  );

  const failureAlreadyReported = useCallback(
    () => Date.now() - failureReportedAtRef.current < FAILURE_DEDUPE_MS,
    [],
  );

  // Names of the missing tools, shared by the warning card and the notice row.
  const missingEnvTools = (env) =>
    !env || env.ok ? [] : [env.node, env.npx].filter((tool) => tool && !tool.found).map((tool) => tool.command);

  const lastEnvOkRef = useRef(null);

  const refreshRuntimeEnv = useCallback(async () => {
    let env = null;
    try {
      const probed = await api.acpRuntimeEnv();
      env = probed && typeof probed === "object" ? probed : null;
    } catch {
      setRuntimeEnv(null);
      return null;
    }
    setRuntimeEnv(env);
    // Only on the transition into missing: otherwise every panel open would
    // push another identical notice.
    if (env && !env.ok && lastEnvOkRef.current !== false) {
      pushNotice("warning", "env-missing", missingEnvTools(env).join(", "));
    }
    lastEnvOkRef.current = Boolean(env?.ok);
    return env;
  }, [pushNotice]);
```

- [ ] **Step 5: 12 处 error 通知改走 `reportFailure`**

把 `src/hooks/useAcpAgent.js` 里全部 12 处 `pushNotice("error", …)` 改成 `reportFailure(…)`（参数不变）。位置：`project-create-failed`（2 处）、`project-delete-failed`、`agent-error`（`stopped` 分支）、`start-failed`、`auth-failed`、`agent-error`（`stop` 的 catch）、`new-session-failed`、`turn-failed`、`mode-failed`、`config-option-failed`、`permission-failed`。

`pushNotice("info", …)` / `pushNotice("warning", …)` 不动。

- [ ] **Step 6: 导出新成员**

在 `src/hooks/useAcpAgent.js` 的 `return { … }` 里加：

```js
    runtimeEnv,
    envMissing: runtimeEnv != null && !runtimeEnv.ok,
    refreshRuntimeEnv,
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm test -- src/hooks/useAcpAgent.test.js`
Expected: 2 passed

- [ ] **Step 8: 提交**

```bash
git add src/lib/tauri-api.js src/hooks/useAcpAgent.js src/hooks/useAcpAgent.test.js src/test/react-render.js
git commit -m "feat(acp): probe Node.js and dedupe repeated failures

The panel now knows whether the built-in agents can start at all, and a
failure that surfaces twice (stream event plus command rejection) is only
reported once inside a five second window."
```

---

### Task 4: 前端 —— 重做报错/通知卡片

**Files:**
- Create: `src/components/panels/acp/AcpNoticeRow.jsx`
- Modify: `src/components/panels/AcpAgentPanel.jsx`（删掉本文件里 525-588 行的 `NoticeRow` 定义，改为 import）
- Test: `src/components/panels/acp/__tests__/AcpNoticeRow.test.js`

`AcpAgentPanel.jsx` 已经 1600 多行，而这一行通知本来就自成一体（对应 eshell-vue 的 `entries/AcpNoticeRow.vue`），所以顺手拆成独立文件，也让它可以单独测。

**Interfaces:**
- Consumes: `entry = { id, type: "notice", tone, code, detail }`（`useAcpAgent` 产出）
- Produces:
  - `export default function AcpNoticeRow({ entry })`
  - `export function noticeCopy(t, code, detail)` → `{ title, body }`；`body: ""` 表示没有正文，`body` 非空且 code 需要原文时等于 `detail`

设计要点（对齐 eshell-vue 的 `AcpNoticeRow.vue`）：

- 标题与正文分离：`code` 决定标题，`detail` 是正文。
- 图标 chip + 背后一团同色环境光（`color-mix` + `blur`）+ 同色系细描边，与 `UiNoticeStack` 同一套视觉。
- 正文用等宽字体（原始报错要方便照着搜、照着念）。
- 正文超 220 字折叠，出「展开详情」。
- error 且有正文时出复制按钮（复制 `标题: 正文`），成功后 1.6 秒内打勾。
- `env-missing` 出「去下载」按钮（`openUrl` 打开 nodejs.org），替代复制。
- **没有正文的非 error 通知退化成一行居中灰字，不画卡片。**

- [ ] **Step 1: 写失败的测试**

新建 `src/components/panels/acp/__tests__/AcpNoticeRow.test.js`：

```js
/**
 * The notice row is the panel's only error surface, so what it shows for
 * each code — and what it refuses to draw a card for — is worth pinning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import AcpNoticeRow from "../AcpNoticeRow.jsx";
import { I18nProvider } from "../../../../lib/i18n.js";
import { installFakeDom, uninstallFakeDom, findElement } from "../../../../test/fake-dom.js";
import { fireClick, render } from "../../../../test/react-render.js";

const textOf = (node) => (node?.textContent ?? "").toString();

const mountNotice = (entry) =>
  render(createElement(I18nProvider, null, createElement(AcpNoticeRow, { entry })));

beforeEach(() => installFakeDom());
afterEach(() => {
  uninstallFakeDom();
  openUrl.mockReset();
});

describe("AcpNoticeRow", () => {
  it("splits a failure into a translated title and the raw detail", async () => {
    const { container, unmount } = await mountNotice({
      id: "n1", type: "notice", tone: "error", code: "start-failed", detail: "spawn npx ENOENT",
    });
    expect(textOf(container)).toContain("Failed to start agent");
    expect(textOf(container)).toContain("spawn npx ENOENT");
    await unmount();
  });

  it("collapses a long body behind Show details", async () => {
    const long = "x".repeat(400);
    const { container, unmount } = await mountNotice({
      id: "n2", type: "notice", tone: "error", code: "turn-failed", detail: long,
    });
    expect(textOf(container)).not.toContain(long);
    expect(findElement(container, (node) => textOf(node).trim() === "Show details")).toBeTruthy();
    await unmount();
  });

  it("expands the collapsed body on click", async () => {
    const long = "x".repeat(400);
    const { container, unmount } = await mountNotice({
      id: "n2b", type: "notice", tone: "error", code: "turn-failed", detail: long,
    });
    const more = findElement(container, (node) => textOf(node).trim() === "Show details");
    await act(async () => fireClick(more));
    expect(textOf(container)).toContain(long);
    await unmount();
  });

  it("renders a body-less non-error notice as a plain line, not a card", async () => {
    const { container, unmount } = await mountNotice({
      id: "n3", type: "notice", tone: "info", code: "session-ended", detail: "",
    });
    expect(findElement(container, (node) => node.getAttribute?.("role") === "status")).toBeNull();
    expect(textOf(container)).toContain("Session ended");
    await unmount();
  });

  it("offers the Node.js download instead of copy for env-missing", async () => {
    const { container, unmount } = await mountNotice({
      id: "n4", type: "notice", tone: "warning", code: "env-missing", detail: "node",
    });
    const link = findElement(container, (node) => textOf(node).trim() === "Get Node.js");
    expect(link).toBeTruthy();
    expect(findElement(container, (node) => node.getAttribute?.("aria-label") === "Copy")).toBeNull();
    await unmount();
  });
});
```

`act` 从 `react` 里一起 import（`import { act, createElement } from "react";`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/components/panels/acp/__tests__/AcpNoticeRow.test.js`
Expected: FAIL —— `Failed to resolve import "../AcpNoticeRow.jsx"`

- [ ] **Step 3: 写 AcpNoticeRow**

新建 `src/components/panels/acp/AcpNoticeRow.jsx`：

```jsx
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../../lib/i18n";
import { copyTextToClipboard } from "../../../utils/clipboard";

const NOTICE_TONES = {
  success: { color: "var(--es-success)", border: 25 },
  warning: { color: "var(--es-warning)", border: 30 },
  info: { color: "var(--es-info)", border: 25 },
  danger: { color: "var(--es-danger)", border: 30 },
};

const NOTICE_ICONS = { info: Info, warning: TriangleAlert, error: AlertTriangle };

const NODE_DOWNLOAD_URL = "https://nodejs.org/";
// Beyond this the raw error is collapsed: the card is a summary, the detail
// is there for whoever needs to read it.
const NOTICE_COLLAPSE_AFTER = 220;

export default function AcpNoticeRow({ entry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);

  const detail = String(entry.detail || "");
  const tone = NOTICE_TONES[entry.tone] || NOTICE_TONES.danger;
  const Icon = NOTICE_ICONS[entry.tone] || Info;
  const isError = entry.tone === "error";

  const copy = noticeCopy(t, entry.code, detail);
  const longBody = copy.body.length > NOTICE_COLLAPSE_AFTER;
  const visibleBody = longBody && !expanded ? `${copy.body.slice(0, NOTICE_COLLAPSE_AFTER)}…` : copy.body;
  const hasBody = Boolean(copy.body);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onCopy = async () => {
    const ok = await copyTextToClipboard(hasBody ? `${copy.title}: ${copy.body}` : copy.title);
    if (!ok) {
      return;
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  // A body-less non-error notice is a line of context, not a card: a card has
  // a border and a background and would interrupt reading for no reason.
  if (!hasBody && !isError) {
    return copy.title ? <p className="py-0.5 text-center text-[11px] text-muted">{copy.title}</p> : null;
  }

  return (
    <section
      role={isError ? "alert" : "status"}
      className="relative isolate overflow-hidden rounded-xl border bg-elevated p-2 text-text"
      style={{
        borderColor: `color-mix(in srgb, ${tone.color} ${tone.border}%, transparent)`,
        boxShadow: `var(--shadow-overlay), 0 10px 32px -12px color-mix(in srgb, ${tone.color} 55%, transparent)`,
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -left-10 -top-12 -z-10 h-32 w-32 rounded-full opacity-20 blur-3xl"
        style={{ background: tone.color }}
      />
      <div className="flex items-start gap-2.5">
        <span
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full"
          style={{ background: `color-mix(in srgb, ${tone.color} 14%, transparent)`, color: tone.color }}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1 pt-px">
          <p className="text-xs font-semibold leading-[1.125rem] text-text">{copy.title}</p>
          {hasBody ? (
            <p className="mt-0.5 font-mono text-[11px] leading-[1.0625rem] text-muted wrap-anywhere">
              {visibleBody}
            </p>
          ) : null}
          {longBody && !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-0.5 text-[11px] font-semibold text-accent hover:underline"
            >
              {t("Show details")}
            </button>
          ) : null}
        </div>

        <div className="flex flex-none items-center gap-0.5">
          {entry.code === "env-missing" ? (
            <button
              type="button"
              title={NODE_DOWNLOAD_URL}
              onClick={() => void openUrl(NODE_DOWNLOAD_URL)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-accent hover:bg-hover"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t("Get Node.js")}</span>
            </button>
          ) : isError && hasBody ? (
            <button
              type="button"
              title={t("Copy")}
              aria-label={t("Copy")}
              onClick={onCopy}
              className="inline-flex h-6 items-center rounded-md px-1.5 text-muted hover:bg-hover hover:text-text"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** `body` equal to `detail` means the body is the raw error text. */
export function noticeCopy(t, code, detail) {
  switch (code) {
    case "session-ended":
      return { title: t("Session ended"), body: "" };
    case "env-missing":
      return {
        title: t("Node.js is not available"),
        body: t(
          "Could not find {tools} on this machine. The built-in agents are launched through npx and cannot start until Node.js is installed.",
          { tools: detail },
        ),
      };
    case "start-failed":
      return { title: t("Failed to start agent"), body: detail };
    case "new-session-failed":
      return { title: t("Failed to start a new session"), body: detail };
    case "project-create-failed":
      return { title: t("Failed to add project"), body: detail };
    case "project-delete-failed":
      return { title: t("Failed to remove project"), body: detail };
    case "turn-stopped":
      if (detail === "cancelled") return { title: t("Turn cancelled"), body: "" };
      if (detail === "refusal") return { title: t("The agent declined this request"), body: "" };
      if (detail === "max_tokens") return { title: t("Stopped: max tokens reached"), body: "" };
      return { title: t("Turn stopped"), body: detail };
    case "turn-failed":
      return { title: t("Turn failed"), body: detail };
    case "auth-failed":
      return { title: t("Sign-in failed"), body: detail };
    case "resume-fallback":
      return {
        title: t("History was not restored"),
        body: t("This agent cannot restore the previous context; a fresh session was created instead."),
      };
    case "mode-failed":
      return { title: t("Failed to switch mode"), body: detail };
    case "config-option-failed":
      return { title: t("Failed to change setting"), body: detail };
    case "permission-failed":
      return { title: t("Failed to respond to permission request"), body: detail };
    case "agent-error":
      return { title: t("Agent error"), body: detail };
    default:
      return { title: detail, body: "" };
  }
}
```

- [ ] **Step 4: 面板改用新组件**

`src/components/panels/AcpAgentPanel.jsx`：

1. 删掉 525-588 行整段 `function NoticeRow({ entry }) { … }`（紧跟其后的 `PlanCard` 保留不动）。
2. import 区加一行：`import AcpNoticeRow from "./acp/AcpNoticeRow";`
3. 渲染处 `if (entry.type === "notice") return <NoticeRow entry={entry} />;`（约 696 行）改成 `<AcpNoticeRow entry={entry} />`。

本文件已有的 lucide import 不需要改动 —— 旧的 `NoticeRow` 一个图标都没用，新组件把图标带在自己文件里。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- src/components/panels/acp/__tests__/AcpNoticeRow.test.js`
Expected: 5 passed

- [ ] **Step 6: 提交**

```bash
git add src/components/panels/acp/AcpNoticeRow.jsx \
        src/components/panels/acp/__tests__/AcpNoticeRow.test.js \
        src/components/panels/AcpAgentPanel.jsx
git commit -m "feat(acp): rebuild the notice row around a title and a body

The old row printed one red line with the title and the raw error glued
together. It now separates them, collapses long errors, offers to copy the
detail, and stops drawing a card for body-less informational notices."
```

---

### Task 5: 前端 —— Node 环境警告卡 + i18n

**Files:**
- Create: `src/components/ai/AcpEnvWarningCard.jsx`
- Modify: `src/components/panels/AcpAgentPanel.jsx`（两处挂载 + props 解构）
- Modify: `src/lib/i18n.js`（`zhMessages` 末尾追加）

**Interfaces:**
- Consumes: `acp.runtimeEnv`（`{ ok, node, npx }`）、`acp.envMissing`、`acp.refreshRuntimeEnv()`
- Produces: `<AcpEnvWarningCard env={runtimeEnv} onRecheck={refreshRuntimeEnv} />`

- [ ] **Step 1: 加文案**

在 `src/lib/i18n.js` 的 `zhMessages` 对象**末尾**（闭合大括号之前）追加：

```js
  // ACP Node.js prerequisite (see panels/AcpAgentPanel.jsx and
  // components/ai/AcpEnvWarningCard.jsx). Keys stay the English source text.
  "Node.js is required": "需要 Node.js 运行环境",
  "Node.js is not available": "未检测到 Node.js",
  "Download Node.js": "前往下载 Node.js",
  "Get Node.js": "去下载",
  "Re-check": "重新检测",
  "not found": "未找到",
  "installed": "已安装",
  "Show details": "展开详情",
  "History was not restored": "未能恢复历史上下文",
  "The built-in agents are launched through npx, so they cannot start without Node.js. Install it, then re-check — no need to restart eShell.":
    "内置的 agent 都通过 npx 拉起，没有 Node.js 就无法启动。装好后点「重新检测」即可，不需要重启 eShell。",
  "Could not find {tools} on this machine. The built-in agents are launched through npx and cannot start until Node.js is installed.":
    "本机找不到 {tools}。内置 agent 通过 npx 启动，安装 Node.js 之前无法运行。",
```

- [ ] **Step 2: 写警告卡**

新建 `src/components/ai/AcpEnvWarningCard.jsx`：

```jsx
import { ExternalLink, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../lib/i18n";

const NODE_DOWNLOAD_URL = "https://nodejs.org/";

const tools = (env) => [env?.node, env?.npx].filter(Boolean);

/**
 * Standing card shown while the built-in agents cannot start at all, so the
 * user is told what is missing instead of being left to read a spawn error.
 * It stays up after a failed start: the notice row says what happened, this
 * says what to do about it.
 */
export default function AcpEnvWarningCard({ env, onRecheck }) {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);

  const missing = tools(env).filter((tool) => !tool.found);
  const installed = tools(env).filter((tool) => tool.found);

  const recheck = async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      window.setTimeout(() => setChecking(false), 400);
    }
  };

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-left">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 flex-none text-warning" aria-hidden="true" />
        <span className="text-xs font-semibold text-text">{t("Node.js is required")}</span>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {t(
          "The built-in agents are launched through npx, so they cannot start without Node.js. Install it, then re-check — no need to restart eShell.",
        )}
      </p>

      <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
        {missing.map((tool) => (
          <li key={tool.command} className="flex items-center justify-between gap-2">
            <span className="text-text/88">{tool.command}</span>
            <span className="text-warning">{t("not found")}</span>
          </li>
        ))}
        {installed.map((tool) => (
          <li key={tool.command} className="flex items-center justify-between gap-2">
            <span className="text-text/88">{tool.command}</span>
            <span className="text-muted">{tool.version || t("installed")}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void openUrl(NODE_DOWNLOAD_URL)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent hover:bg-accent/88"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Download Node.js")}
        </button>
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-text/88 hover:bg-hover disabled:opacity-50"
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t("Re-check")}
        </button>
      </div>

      <p className="mt-1.5 text-[10px] text-subtle">{NODE_DOWNLOAD_URL}</p>
    </div>
  );
}
```

- [ ] **Step 3: 挂到面板上**

`src/components/panels/AcpAgentPanel.jsx`：

1. 顶部加 import：`import AcpEnvWarningCard from "../ai/AcpEnvWarningCard";`
2. `AcpAgentPanel({ acp })` 的解构里加 `runtimeEnv,`、`envMissing,`、`refreshRuntimeEnv,`
3. 启动区（`!ready && transcript.length === 0`，约 1374 行）在 `<div className="flex h-full flex-col items-center justify-center …">` **内部最前面**插入：

```jsx
            {envMissing ? (
              <div className="w-full max-w-full">
                <AcpEnvWarningCard env={runtimeEnv} onRecheck={refreshRuntimeEnv} />
              </div>
            ) : null}
```

4. 转写区（`<div className="space-y-2">`，约 1422 行）在 `{!ready && transcript.length > 0 ? (` **之前**插入：

```jsx
            {envMissing ? (
              <AcpEnvWarningCard env={runtimeEnv} onRecheck={refreshRuntimeEnv} />
            ) : null}
```

- [ ] **Step 4: 面板打开时探测**

`src/App.jsx` 里已有的那段「打开 AI 面板就刷新 agent 列表」的 effect 改成同时探测环境：

```jsx
  // Pick up acp_agents.json edits without an app restart, and re-probe the
  // Node.js toolchain: the user may have installed it since the last open.
  useEffect(() => {
    if (workbench.showAiPanel) {
      void acp.refreshAgents();
      void acp.refreshRuntimeEnv();
    }
  }, [workbench.showAiPanel, acp.refreshAgents, acp.refreshRuntimeEnv]);
```

- [ ] **Step 5: 跑测试**

Run: `npm test`
Expected: 全绿（含 Task 3、Task 4 新增的用例）

- [ ] **Step 6: 提交**

```bash
git add src/components/ai/AcpEnvWarningCard.jsx src/components/panels/AcpAgentPanel.jsx src/lib/i18n.js src/App.jsx
git commit -m "feat(acp): warn when Node.js is missing

Adds a standing card that names the missing tool, links to the download
page and re-probes on demand, so a machine without Node.js explains
itself instead of failing at the first spawn."
```

---

### Task 6: 窗口圆角 —— 平台配置

**Files:**
- Create: `src-tauri/tauri.linux.conf.json`
- Create: `src-tauri/tauri.macos.conf.json`
- Modify: `src-tauri/Cargo.toml:21`
- Test: `src-tauri/tests/platform_window_config.rs`（新建）

**Interfaces:** 无代码接口；产出是 Linux / macOS 上窗口带 `transparent: true`。

Tauri 平台配置走 JSON Merge Patch（RFC 7396），**数组整体替换**，所以 `windows` 必须写全，不能只写 `transparent`。代价是 window 对象出现三份 —— 下面的漂移测试就是为此。

- [ ] **Step 1: 写漂移测试**

新建 `src-tauri/tests/platform_window_config.rs`：

```rust
//! The platform configs exist only to flip `transparent` on Linux and macOS.
//! Because JSON Merge Patch replaces arrays wholesale, each file repeats the
//! whole window object — this test is what keeps the copies from drifting.

use std::path::Path;

fn read(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {name}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

#[test]
fn platform_window_objects_match_the_base_except_for_transparency() {
    let base = read("tauri.conf.json");
    let base_window = &base["app"]["windows"][0];

    for name in ["tauri.linux.conf.json", "tauri.macos.conf.json"] {
        let platform = read(name);
        let window = &platform["app"]["windows"][0];

        assert_eq!(window["transparent"], serde_json::json!(true), "{name}");

        let mut expected = base_window.clone();
        expected["transparent"] = serde_json::json!(true);
        assert_eq!(window, &expected, "{name} window drifted from tauri.conf.json");
    }
}

#[test]
fn macos_asks_for_the_private_transparency_api() {
    let macos = read("tauri.macos.conf.json");
    assert_eq!(macos["app"]["macOSPrivateApi"], serde_json::json!(true));
}
```

`serde_json = "1"` 已经在 `src-tauri/Cargo.toml` 的 `[dependencies]` 里（第 24 行），测试目标可以直接用，Cargo.toml 不需要改动。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test platform_window_config`
Expected: FAIL —— `read tauri.linux.conf.json` 打不开（文件还不存在）

- [ ] **Step 3: 建两份平台配置**

`src-tauri/tauri.linux.conf.json`：

```json
{
  "app": {
    "windows": [
      {
        "title": "eshell",
        "width": 1200,
        "height": 780,
        "minWidth": 1040,
        "minHeight": 700,
        "decorations": false,
        "resizable": true,
        "visible": false,
        "transparent": true
      }
    ]
  }
}
```

`src-tauri/tauri.macos.conf.json`：同上，另加 `"macOSPrivateApi": true`（与 `windows` 同级，放在 `app` 下）：

```json
{
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "title": "eshell",
        "width": 1200,
        "height": 780,
        "minWidth": 1040,
        "minHeight": 700,
        "decorations": false,
        "resizable": true,
        "visible": false,
        "transparent": true
      }
    ]
  }
}
```

- [ ] **Step 4: 打开 macOS 私有透明 API 的 feature**

`src-tauri/Cargo.toml:21`：

```toml
tauri = { version = "2", features = ["macos-private-api"] }
```

（`macOSPrivateApi` 在 macOS 上要求这个 feature，否则透明不生效。其他平台编译不受影响。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src-tauri && cargo test --test platform_window_config`
Expected: 2 passed

- [ ] **Step 6: 提交**

```bash
git add src-tauri/tauri.linux.conf.json src-tauri/tauri.macos.conf.json src-tauri/Cargo.toml src-tauri/tests/platform_window_config.rs
git commit -m "feat(window): enable window transparency on Linux and macOS

Rounded corners need a transparent window, and Tauri only exposes
transparency through the builder, so it has to come from the platform
configs. The window objects are repeated because JSON Merge Patch replaces
arrays wholesale; a test keeps the copies honest.

Windows is untouched: it already gets native rounded corners and a system
drop shadow from the compositor."
```

---

### Task 7: 窗口圆角 —— 底色与启动 splash

**Files:**
- Modify: `src-tauri/src/boot.rs`（`reveal` 里的 `set_background_color`）
- Modify: `index.html`（`<head>` 内联脚本 + splash 样式）
- Modify: `src/index.css`（`body` 底色、`.app-shell` 圆角）

**Interfaces:**
- Produces: `<html data-desktop-platform="macos|linux|windows|unknown">`，CSS 与 `App.jsx` 都读它。

- [ ] **Step 1: boot.rs 不再给透明窗口刷底色**

`src-tauri/src/boot.rs` 的 `reveal` 里，把刷底色那段包进平台判断：

```rust
    // Windows keeps an opaque window, so tinting it to the splash colour is
    // what stops the frame right after `show()` from being white. Linux and
    // macOS declare `transparent: true` in their platform configs, and a
    // tinted background there would fill the CSS corners back in.
    if cfg!(target_os = "windows") {
        if let Some(color) = background.and_then(parse_hex_color) {
            if let Err(error) = window.set_background_color(Some(color)) {
                trace(&format!("could not tint the window background: {error}"));
            }
        }
    }
```

- [ ] **Step 2: index.html 里提前写平台属性**

在 `index.html` `<head>` 那段已有的内联 `<script>`（读 `eshell:theme` 的那段）里，紧跟着主题之后加：

```js
        // The transparent-window platforms round the shell with CSS, and the
        // splash is painted before any module loads — so the platform has to
        // be on <html> this early. The window is created hidden and only shown
        // once `boot_ready` fires, so nothing square is ever on screen.
        var ua = String(
          (navigator.userAgentData && navigator.userAgentData.platform) ||
            navigator.platform ||
            navigator.userAgent ||
            "",
        ).toLowerCase();
        var desktop =
          ua.indexOf("mac") === 0 || ua.indexOf("mac") >= 0
            ? "macos"
            : ua.indexOf("win") >= 0
              ? "windows"
              : ua.indexOf("linux") >= 0
                ? "linux"
                : "unknown";
        document.documentElement.setAttribute("data-desktop-platform", desktop);
```

- [ ] **Step 3: splash 在这些平台上带圆角**

`index.html` 的 splash `<style>` 里，把 `html, body { background: #e8ecf2 }` 那条改成：

```css
      html,
      body {
        margin: 0;
        background: #e8ecf2;
      }
      /* Transparent window: the splash paints the frame, so it has to round
         itself or the corners would be filled in square. */
      html[data-desktop-platform="macos"],
      html[data-desktop-platform="linux"],
      html[data-desktop-platform="macos"] body,
      html[data-desktop-platform="linux"] body {
        background: transparent;
      }
```

并在 `#boot-splash` 规则里补一行：

```css
        border-radius: 10px;
```

- [ ] **Step 4: index.css 把底色挪到 shell**

`src/index.css`：

1. `body` 规则里的 `background: var(--es-bg);` 删掉，换成注释与透明声明：

```css
  /* The window is transparent on Linux and macOS (see the platform configs),
     and the shell paints the frame so its corners can be rounded. Windows
     keeps the opaque background here. */
  background: var(--es-bg);
```

```css
html[data-desktop-platform="macos"] body,
html[data-desktop-platform="linux"] body {
  background: transparent;
}
```

2. `.app-shell` 规则补上底色与圆角：

```css
.app-shell {
  overscroll-behavior: none;
  background: var(--es-bg);
}

/* Only where the window is transparent, and only while unmaximized: a
   maximized window with rounded corners leaves notches at the screen edges. */
html[data-desktop-platform="macos"] .app-shell.is-rounded,
html[data-desktop-platform="linux"] .app-shell.is-rounded {
  border-radius: 10px;
}
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/boot.rs index.html src/index.css
git commit -m "feat(window): paint the frame in the shell so the corners can round

The boot splash and the shell now carry the same radius on the transparent
platforms, and the window background tint is skipped there because it would
fill the corners back in."
```

---

### Task 8: 窗口圆角 —— 最大化状态提到共享状态

**Files:**
- Create: `src/utils/desktopPlatform.js`
- Modify: `src/main.jsx`（启动时写平台属性）
- Modify: `src/components/layout/WindowTitleBar.jsx`（平台探测改 import；`isMaximized` 改由外部传入）
- Modify: `src/hooks/useWorkbench.js`（UI 片加 `isMaximized`）
- Modify: `src/components/app/AppWorkspace.jsx`（把 `isMaximized` 传给 WindowTitleBar）
- Modify: `src/App.jsx`（`.app-shell` 加 `is-rounded`）

**Interfaces:**
- Produces:
  - `detectDesktopPlatform(): "macos" | "windows" | "linux" | "unknown"`（`src/utils/desktopPlatform.js`）
  - `applyDesktopPlatformAttribute(): void`
  - `workbench.isMaximized: boolean`
- Consumes: `getCurrentWindow().isMaximized()`、`onResized`

**只保留一处订阅**：`WindowTitleBar` 现在的 `useState` + `onResized` 效果整体搬进 `useWorkbench`，标题栏按钮与根节点圆角都从那里读。

- [ ] **Step 1: 抽平台探测**

新建 `src/utils/desktopPlatform.js`，把 `WindowTitleBar.jsx` 里的 `detectDesktopPlatform` 原样搬过来并加一个写属性的入口：

```js
/**
 * The desktop platform as the UI needs it. Tauri's webviews report the host
 * through the usual navigator fields, so no IPC is involved.
 */
export function detectDesktopPlatform() {
  if (typeof window === "undefined") {
    return "unknown";
  }

  const source =
    window.navigator?.userAgentData?.platform ||
    window.navigator?.platform ||
    window.navigator?.userAgent ||
    "";
  const normalized = String(source).toLowerCase();

  if (normalized.includes("mac")) {
    return "macos";
  }
  if (normalized.includes("win")) {
    return "windows";
  }
  if (normalized.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

/** Mirrors the attribute `index.html` writes, once the module graph is up. */
export function applyDesktopPlatformAttribute() {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-desktop-platform", detectDesktopPlatform());
}
```

- [ ] **Step 2: main.jsx 里调用**

在 `src/main.jsx` 的 `bootMark("modules loaded");` 之后加：

```js
applyDesktopPlatformAttribute();
```

并在 import 区加 `import { applyDesktopPlatformAttribute } from "./utils/desktopPlatform";`。

- [ ] **Step 3: useWorkbench 接管最大化状态**

`src/hooks/useWorkbench.js`：

1. import 区加：

```js
import { getCurrentWindow } from "@tauri-apps/api/window";
```

2. 状态区加：

```js
  const [isMaximized, setIsMaximized] = useState(false);
```

3. 加一个订阅效果（浏览器预览里 `getCurrentWindow()` 会抛，静默跳过，`isMaximized` 停在 false，圆角照样有）：

```js
  // The only place that asks the window whether it is maximized: the title
  // bar's button and the shell's corner radius both read this. Two
  // subscriptions would mean two chances to miss an event.
  useEffect(() => {
    let mounted = true;
    let unlisten = null;

    const sync = async () => {
      try {
        const value = await getCurrentWindow().isMaximized();
        if (mounted) {
          setIsMaximized(value);
        }
      } catch {
        // noop: keep browser preview usable outside the tauri runtime
      }
    };

    const bind = async () => {
      try {
        await sync();
        unlisten = await getCurrentWindow().onResized(sync);
      } catch {
        // noop
      }
    };

    void bind();

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);
```

4. `return { … }` 里加 `isMaximized,`。

- [ ] **Step 4: WindowTitleBar 改读传入值**

`src/components/layout/WindowTitleBar.jsx`：

1. 删掉本文件里的 `detectDesktopPlatform` 定义，改成 `import { detectDesktopPlatform } from "../../utils/desktopPlatform";`
2. 删掉 `const [isMaximized, setIsMaximized] = useState(false);` 与那段 `onResized` 订阅效果；改为从 props 取：函数签名加 `isMaximized = false,`。
3. `handleToggleMaximize` 里的 `setIsMaximized(await appWindow.isMaximized());` 删掉（`onResized` 会同步回来）。
4. 保留 `useState` 的 import（`detectedPlatform` / `platformKind` 还在用）。

- [ ] **Step 5: AppWorkspace 透传**

`src/components/app/AppWorkspace.jsx`：

1. 从 `workbench` 的解构里加 `isMaximized,`。
2. `<WindowTitleBar … />`（约 71 行）加 `isMaximized={isMaximized}`。

- [ ] **Step 6: App.jsx 切圆角**

`src/App.jsx` 的根节点：

```jsx
    <div
      className={`app-shell flex h-full w-full min-h-0 flex-col overflow-hidden text-text${
        workbench.isMaximized ? "" : " is-rounded"
      }`}
    >
```

- [ ] **Step 7: 跑测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add src/utils/desktopPlatform.js src/main.jsx src/hooks/useWorkbench.js src/components/layout/WindowTitleBar.jsx src/components/app/AppWorkspace.jsx src/App.jsx
git commit -m "refactor(window): one maximized subscription for the bar and the shell

The shell needs to know whether the window is maximized to decide on its
corner radius, and the title bar already tracked it. Lifting it into the
workbench hook keeps a single listener instead of two."
```

---

## 验证

- [ ] `cd src-tauri && cargo test` 全绿
- [ ] `npm test` 全绿
- [ ] Windows 上 `npm run tauri dev`：外观与改动前**完全一致**（无透明、无 CSS 圆角、系统投影还在）
- [ ] Linux / macOS 上 `npm run tauri dev`：窗口四角圆、最大化后四角变方、启动 splash 也是圆的
- [ ] 装一台没有 Node.js 的机器（或在 PATH 里屏蔽 `node`）：打开 AI 面板出现警告卡，点「重新检测」能恢复

## 非目标

- 不搬 `796a928` 的中文注释改写，不刷 `Cargo.lock`。
- 不改 Windows 的窗口外观。
- 不搬 eshell-vue 的前端架构（`src/api` 分层、Pinia store 拆分）。
