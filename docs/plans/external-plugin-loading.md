# 外部插件加载（路线 A）实现计划

> 状态：阶段 0–3 已完成；已通过单元/集成、内置 UI 回归和真实 Windows WebView2 验证
> 验证记录：[external-plugin-loading-validation.md](../reports/external-plugin-loading-validation.md)
> 目标读者：实现者
> 执行接口约定：见 [external-plugin-contract.md](external-plugin-contract.md)，补齐通用 UI 消费端、调用方 lease、持久化事务和共享 React 细节。
> 前置决策：**不做安全隔离**。插件是用户自己安装的本地代码，信任模型与 Obsidian / 早期 VSCode 一致，插件与主程序同进程、同 JS 上下文。本文档中的 "API 门面" 是**契约**，不是**沙箱**。

---

## 1. 目标与非目标

### 目标

1. 用户可以把插件目录放进本地扩展目录，应用启动时发现并加载它。
2. 插件通过 `activate(api)` 生命周期注册 UI 贡献点（面板、工具栏）与行为。
3. 插件通过宿主注入的 `eshell` API 对象访问后端能力，**不直接依赖 `src/lib/tauri-api.js` 等内部模块**。
4. 内置插件（sftp、server-monitor）迁移到同一套 API 门面，作为该门面的第一个消费者与回归基线。
5. 插件的启用/禁用状态持久化，重启后保留。

### 非目标（明确不做）

- **不做进程/Worker 隔离**。插件与主程序同上下文，可访问 `window`、`localStorage`、`window.__TAURI_INTERNALS__`。
- **不做权限声明与运行时鉴权**。Tauri capability 是编译期、按窗口授权的，无法按插件粒度收窄；插件能调到的命令等同于主程序能调到的命令。
- **不做插件市场 / 签名 / 自动更新**。
- **不改动现有贡献点机制**（`registry.js` / `contributions.js` 的排序与 enabled 过滤逻辑保持不变）。
- **不做热重载**。插件变更需重启应用生效。

---

## 2. 现状（实现前必读）

| 位置 | 现状 | 对本计划的影响 |
|---|---|---|
| `src-tauri/src/plugins/manifest.rs:13` | `include_str!("../../../extensions/builtin.json")`，编译期嵌入 | 外部插件清单必须走运行时读取，不能复用这条路径 |
| `src-tauri/src/plugins/manifest.rs:77` | `if !entry.builtin { return Err(...) }` | 硬性拒绝外部插件，必须放开 |
| `src-tauri/src/state.rs:114` | 启动时 `BuiltinManifest::parse()` 一次 | 需改为「内置 + 外部」合并 |
| `src/plugins/index.jsx:5-6` | 静态 `import { createSftpPlugin }` | 必须改为动态加载 |
| `src/plugins/registry.js:11` | 模块级 `Map`，注册是同步的 | 动态加载必须在 React 首次渲染**之前**完成，否则贡献点解析会漏 |
| `src/plugins/contributions.js:15` | `resolvePanelContributions(extensions)` 同步查注册表 | 保持同步，靠加载时序保证 |
| `src/plugins/sftp/effects.js:4` | 直接 `import { api } from "../../lib/tauri-api"` | 迁移目标：改为从注入的 api 对象取 |
| `src-tauri/src/plugins/registry.rs` | 已有 lease / generation / busy 机制 | 复用，不重写 |
| `src-tauri/src/plugins/lifecycle.rs` | `apply_activation` 用 `match extension_id` 硬编码 | 外部插件需要通用化的停用路径 |
| `src-tauri/src/lib.rs:143` | 存储根 = 进程 cwd 下的 `.eshell-data` | 扩展目录沿用同一根，保持一致 |
| `src-tauri/tauri.conf.json` | `"csp": null`，未配置 `assetProtocol` | 影响插件 bundle 的加载方式（见 3.3） |

---

## 3. 设计

### 3.1 目录与清单

扩展根目录：`.eshell-data/extensions/`（与现有存储根一致）。

```
.eshell-data/
  extensions/
    state.json                    # 用户启用/禁用状态（持久化）
    com.example.my-plugin/
      manifest.json
      index.js                    # ESM bundle，default 或命名导出 activate
      assets/                     # 可选
```

`manifest.json` 复用现有 `BuiltinExtensionEntry` 结构，新增两个字段：

```jsonc
{
  "id": "com.example.my-plugin",     // 必填，全局唯一，建议反向域名
  "displayName": "My Plugin",        // 必填
  "version": "1.0.0",                // 必填
  "apiVersion": 1,                   // 必填，必须等于宿主支持的版本
  "builtin": false,                  // 外部插件必须为 false
  "defaultEnabled": true,            // 可选，默认 true
  "main": "index.js",                // 新增，可选，默认 "index.js"
  "contributes": {                   // 可选，仅用于排序与预声明
    "panels": [{ "id": "my-panel", "order": 30 }]
  }
}
```

**校验规则**（在 Rust 侧，加载时执行，失败则该插件被跳过并在日志中记录原因，不影响其他插件与启动）：
- `id` 非空、唯一（与内置及其他外部插件都不冲突）
- `apiVersion` 等于宿主支持的版本（当前为 `1`）
- `builtin` 必须为 `false`（外部目录里出现 `builtin: true` 视为非法，防止伪造内置插件）
- `main` 指向的文件必须存在于插件目录内，且路径不得逃逸出插件目录（拒绝 `../`）

### 3.2 加载时序（关键）

贡献点解析是同步的，所以**插件必须在 React 首次渲染前加载完毕**。

```
应用启动
  → registerBuiltinPlugins()            // 现有逻辑不变
  → await loadExternalPlugins()         // 新增：读清单 + 动态 import + activate
  → createRoot().render(<App />)        // 之后才渲染
```

`loadExternalPlugins()` 的职责：
1. 调后端命令拿到外部插件清单（含解析后的 bundle URL）
2. 逐个 `import(/* @vite-ignore */ bundleUrl)`
3. 调用模块导出的 `activate(api)`，把返回的 dispose 函数存起来
4. 注册进现有 `registry.js`（复用 `registerPlugin`）
5. 任一插件加载失败 → 记录错误、跳过该插件，**不阻断启动**

> 注意：`import()` 的 URL 必须是运行时拼接的，Vite 会尝试静态分析并报错，需要 `/* @vite-ignore */` 注释。

### 3.3 插件 bundle 的加载方式（本计划最大的技术风险）

生产环境下页面 origin 是 `http://tauri.localhost`（Windows）/ `tauri://localhost`（macOS），**不能直接 `import("file:///...")`**——会被 CORS 拦掉。三种方案：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 自定义 URI scheme（采用）** | `Builder::register_uri_scheme_protocol("plugin", ...)`，把 `http://plugin.localhost/<id>/index.js` 映射到扩展目录，响应带 JavaScript MIME 与 `Access-Control-Allow-Origin: *` | 在实际 Tauri Builder 中新增；本仓不存在原先引用的 `src-tauri/src/ipc/protocol.rs` |
| B. assetProtocol | 开启 `app.security.assetProtocol` 并配置 scope，用 `convertFileSrc` | 该协议主要面向媒体资源，JS 模块的 MIME/CORS 行为不确定，风险高 |
| C. 读文本 + Blob URL | 后端命令读文件内容，前端 `new Blob` + `URL.createObjectURL` | 相对导入会失效，且 CSP 收紧后不可用，不推荐 |

**采用方案 A。** 实现要点：
- 协议 handler 必须做路径规范化，拒绝 `..` 逃逸，只允许读扩展根目录下的文件
- 只允许 `.js` / `.mjs` / `.css` / 图片等白名单后缀
- 返回 404 而非 panic，插件文件缺失不应崩溃

### 3.4 API 门面

新增 `src/plugins/api.js`，导出 `createPluginApi(pluginId)`。插件拿到的是这个对象，**不暴露 `invoke`**。

```js
// 插件模块的形态
export async function activate(eshell) {
  const dispose = eshell.sftp.onTransfer((evt) => { /* ... */ });
  eshell.ui.registerPanel({
    id: "my-panel",
    order: 30,
    key: "my-panel",
    render: (props) => <MyPanel {...props} />,
  });
  return () => dispose();   // 可选：deactivate
}
```

API 面（v1 范围，按内置插件的实际用量裁剪）：

```js
eshell = {
  // 会话
  sessions: {
    list(), open(configId), close(sessionId), execute(sessionId, command),
    onOutput(cb), onClosed(cb), onHostKeyPrompt(cb),
  },
  // SFTP
  sftp: {
    listDir(sessionId, path), readFile(sessionId, path), writeFile(sessionId, path, content),
    createFile, createDirectory, deleteEntry, renameEntry,
    uploadLocalFile(sessionId, remotePath, localPath, transferId, localName),
    downloadToLocal(sessionId, remotePath, localDir, transferId),
    cancelTransfer(transferId),
    selectUploadFile(), selectDownloadDir(defaultPath),
    onTransfer(cb),
  },
  // 服务器状态
  status: { fetch(sessionId, nic), cached(sessionId) },
  // UI 贡献点
  ui: { registerPanel(panel), registerToolbar(item) },
  // 按插件 id 命名空间隔离的持久化
  storage: { get(key), set(key, value), remove(key) },
  log: { info(...), warn(...), error(...) },
  meta: { pluginId, apiVersion },
}
```

**事件必须包装。** 现在插件直接 `listen("sftp-transfer")`，若不包装则所有插件都能收到所有事件——包括 `pty-output`（终端原始输出）。`eshell.sftp.onTransfer(cb)` 这类包装由宿主内部做过滤与转发；`pty-output` 不进插件 API，只保留 `sessions.onOutput` 这种明确语义的入口。

**`storage` 必须按插件 id 加前缀**，避免插件之间互相覆盖 localStorage key。

### 3.5 生命周期与启用状态

- 启用状态持久化到 `.eshell-data/extensions/state.json`，形如 `{ "com.example.my-plugin": { "enabled": false } }`。
- 复用现有 `ExtensionRegistry` 的 lease / generation 机制，不重写。
- `src-tauri/src/plugins/lifecycle.rs:38` 的 `apply_activation` 目前是 `match extension_id` 硬编码内置插件，需要补一条通用分支：外部插件的停用由前端调用其 `deactivate()` 完成（后端只负责标记状态并广播 `extensions-changed`）。
- 停用插件时，前端需要：调用 dispose → 从 `registry.js` 注销 → 移除其贡献的面板。**注意 `registry.js:27` 的 `registerPlugin` 已返回注销函数，但目前无人调用**，这里正好用上。

### 3.6 与现有贡献点机制的衔接

**不改** `contributions.js` 的排序与过滤逻辑。外部插件注册进同一个 `registry.js`，`resolvePanelContributions` 天然就能看到它们。唯一需要确认的是：外部插件的面板 id 与内置插件不冲突（在加载时校验，冲突则跳过并记录）。

---

## 4. 任务分解

### 阶段 0：API 门面 + 内置插件迁移（可独立交付）

> 这一阶段不引入任何外部插件能力，但**必须先做**：用现有插件当第一个消费者，API 面才不会被设计歪。做完即可单独合入。

- [x] 0.1 新增 `src/plugins/api.js`，实现 `createPluginApi(pluginId)`，先覆盖 `sessions` / `sftp` / `status` / `ui` / `storage` / `log`
- [x] 0.2 `storage` 实现按 pluginId 加前缀的 localStorage 读写
- [x] 0.3 事件包装：`sftp.onTransfer` / `sessions.onOutput` / `sessions.onClosed` / `sessions.onHostKeyPrompt`，内部做过滤
- [x] 0.4 改造 `src/plugins/sftp/`：`effects.js`、`operations.js`、`SftpPanel.jsx` 不再 import `tauri-api`，改从 controller 上下文取 api
- [x] 0.5 改造 `src/plugins/status/`：同上
- [x] 0.6 `src/plugins/index.jsx` 的 `registerBuiltinPlugins()` 改为向插件传入 api 对象
- [x] 0.7 补测试：`src/plugins/__tests__/api.test.js`，覆盖 storage 命名空间隔离、事件过滤、api 面不暴露 `invoke`

**验收**：`npm run test` 全绿；sftp 与 status 插件功能与改造前一致；`src/plugins/` 生产模块不直接导入 `tauri-api` 或 Tauri event/dialog 包（测试中的边界 mock、注释不计），只有 `src/lib/plugin-host.js` 私有桥接触这些内部接口。

### 阶段 1：清单发现与动态加载

- [x] 1.1 `src-tauri/src/plugins/manifest.rs`：抽出 `ExtensionEntry` 通用结构，内置清单与外部清单共用；新增 `main` 字段（可选，默认 `index.js`）
- [x] 1.2 放开 `builtin: false` 校验；新增外部清单校验（id 唯一、apiVersion 匹配、`builtin` 必须为 false、`main` 路径不逃逸）
- [x] 1.3 新增 `src-tauri/src/plugins/discovery.rs`：扫描 `.eshell-data/extensions/*/manifest.json`，解析失败逐条记录并跳过
- [x] 1.4 `src-tauri/src/state.rs`：启动时合并内置 + 外部清单
- [x] 1.5 注册 `plugin://` URI scheme（见 3.3），做路径规范化与后缀白名单
- [x] 1.6 新增 Tauri 命令 `list_external_plugins`，返回外部插件清单 + bundle URL
- [x] 1.7 前端新增 `src/plugins/loader.js`：`loadExternalPlugins()`，动态 import + activate + 注册
- [x] 1.8 在应用入口（`src/main.jsx` 或等价位置）于首次渲染前 `await loadExternalPlugins()`
- [x] 1.9 加载失败必须降级：记录错误、跳过该插件、不阻断启动

**验收**：手工放一个最小插件到 `.eshell-data/extensions/`，重启应用后面板出现；删掉插件目录后重启，应用正常启动且无残留面板。

### 阶段 2：启用状态持久化与停用

- [x] 2.1 `.eshell-data/extensions/state.json` 读写，复用现有 storage 层风格
- [x] 2.2 `ExtensionRegistry` 初始化时读取持久化状态，覆盖 `defaultEnabled`
- [x] 2.3 `set_extension_enabled` 成功后写入 state.json
- [x] 2.4 `lifecycle.rs` 补外部插件的通用停用分支
- [x] 2.5 前端停用路径：调用插件 dispose → `registry.js` 注销 → 面板消失；启用路径：重新 import + activate
- [x] 2.6 停用时若插件有在途操作，复用现有 lease 机制拒绝停用（与内置插件行为一致）

**验收**：停用外部插件 → 面板消失 → 重启 → 仍是停用状态；启用 → 面板回来。

### 阶段 3：文档与示例

- [x] 3.1 写 `docs/guides/features/plugin_development.md`：清单字段、`activate` 契约、API 面参考、调试方法
- [x] 3.2 在仓库内提供 `examples/hello-plugin/`（一个面板 + 一个工具栏按钮 + 一次 storage 读写），作为可运行的参考实现
- [x] 3.3 更新 `docs/guides/architecture/backend_architecture.md` 中扩展系统一节
- [x] 3.4 更新 `docs/releases/unreleased.md`

---

## 5. 风险与注意事项

| 风险 | 说明 | 应对 |
|---|---|---|
| **bundle 加载失败**（最高风险） | 自定义协议、CORS、MIME 任一环节出错，插件都加载不了 | 阶段 1 第一件事就是把 `plugin://` 协议跑通，用一个 hello world 验证，再往下做 |
| 加载时序 | 贡献点解析是同步的，插件异步加载 | 强制在首次渲染前 await 完成；不要试图改成异步渲染 |
| 插件阻塞启动 | 导入或 `activate` 异步挂起、抛异常，或同步死循环 | 导入与激活均设异步超时，失败清理并跳过；同步死循环在同 JS 上下文中无法被超时打断，必须作为信任模型限制说明 |
| 插件 id 冲突 | 外部插件与内置插件同 id | 加载时校验，冲突则跳过并记录 |
| 路径逃逸 | 插件清单的 `main` 指向扩展目录之外 | 规范化后校验前缀；协议 handler 同样校验 |
| 现有重构未提交 | 工作区有大量未提交改动（`src/plugins/` 新建、`src/components/panels/sftp/` 删除） | 保留现有改动并建立工作区基线；未经用户明确要求不自动提交或还原已有文件 |

---

## 6. 本轮执行决策

1. **v1 不暴露 `ptyWriteInput`**，保留会话查询与明确的非交互命令执行 API。
2. **允许 `ui.registerController`**，每个外部插件通过独立 keyed React 组件持有 hooks；不在 `useWorkbench` 中动态循环调用 controller。
3. **`apiVersion` 不匹配直接拒绝该插件**，记录错误但不阻断其他插件和应用启动。
4. **保留 cwd 下的 `.eshell-data`**，数据目录迁移另行处理。
5. **补齐通用消费端与共享 React**：原有 0/1/2/3 面板布局保持；新面板无需给宿主增加 ID 分支，并支持更多面板；外部代码通过 `eshell.react` 使用同一 React 实例。
6. **保留 `onHostKeyPrompt` 的只读语义，但新增实际信号桥**：它不是原生现有事件，不得错误映射到 `ssh-ki-prompt`，不提供自动信任或密码回复通道。
7. **调用方 lease 与持久化失败都必须真实处理**：外部 API 调用由原生 broker 持调用方 lease；写状态失败拒绝转移，不能只记日志仍返回成功。

---

## 7. 参考：相关文件索引

```
后端
  src-tauri/src/plugins/manifest.rs      清单解析与校验（需改）
  src-tauri/src/plugins/registry.rs      激活注册表与 lease（复用）
  src-tauri/src/plugins/lifecycle.rs     激活/停用（需补通用分支）
  src-tauri/src/plugins/commands.rs      list_extensions / set_extension_enabled
  src-tauri/src/state.rs:114             启动时清单加载（需改）
  src-tauri/src/lib.rs:143               存储根解析

前端
  src/plugins/index.jsx                  内置插件注册（需改为动态加载）
  src/plugins/registry.js                插件注册表（复用，注意已有注销函数未被调用）
  src/plugins/contributions.js           贡献点解析（不改）
  src/plugins/extensions/extensionState.js  enabled 状态与 extensions-changed 订阅
  src/plugins/sftp/                      迁移到 api 门面的第一个消费者
  src/plugins/status/                    同上
  src/lib/tauri-api.js                   现有 invoke 门面（被 api.js 包装）

消费点
  src/components/app/AppMainWorkspace.jsx:99   resolvePanelContributions
  src/components/layout/TopToolbar.jsx:91      resolveToolbarContributions
```
