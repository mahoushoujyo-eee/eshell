---
name: eshell-plugin-dev
description: >-
  Write, install, debug, or review an eShell external plugin (browser-ESM
  plugin under `.eshell-data/extensions/<id>/`). Use when the user asks to
  create a plugin / extension for eShell, add a panel or toolbar button, call
  eShell's session, SFTP or server-status APIs from plugin code, understand
  why a plugin did not load or its panel is missing, or asks what a plugin can
  and cannot do. Covers the manifest schema, the full API v1 facade, the
  lifecycle and contribution rules, the install/enable/restart flow, and the
  trust model. Not for editing eShell's built-in Rust/React code, and not for
  editing `.eshell-data` config files (use eshell-config).
---

# eShell 插件开发指南

外部插件是**用户放进本地扩展目录的浏览器 ESM 模块**。应用启动时发现清单，通过
`plugin://` 自定义协议加载代码，调用 `activate(eshell)`。不需要重新编译 eShell。

⚠️ **信任边界（必须在回复里说清）**：插件与 eShell **共用同一个 JS 上下文**，
能访问 `window`、`localStorage` 和主窗口的 Tauri 能力。下面的 API 是**稳定调用契约
与资源管理入口，不是安全边界**。只安装自己信任的代码。

权威参考：`docs/guides/features/plugin_development.md`（完整 API 文档）、
`examples/hello-plugin/`（最小可加载示例）、`examples/docker-plugin/`（完整示例，
含 controller、异步取数、错误分类、单元测试）。

## 1. 安装与生效

**没有插件市场、没有签名、没有自动更新。**

### 推荐：设置里的「插件」标签页

**设置 → 插件**列出全部内置 + 外部扩展，每行可以启用/禁用。外部插件还可以：

- **从文件夹安装…**：选一个插件目录，应用会把它复制到
  `<storage-root>/extensions/<清单里的 id>/` 并立即生效，**不需要重启**。
  目标目录名取自清单的 `id`，不是源文件夹名。
- **移除**：删除插件目录并清除它的启用状态记录。内置扩展只能禁用，不能移除。

安装会走和启动扫描**完全相同的校验规则**（清单可解析、`apiVersion` 匹配、
`builtin: false`、`main` 在目录内）。校验不通过会在复制之前就拒绝，不会留下半个插件。
覆盖安装同一个 id 是允许的（升级路径）；旧副本先移开，复制失败会还原。

移除在插件**有操作在途**时会被拒绝——删掉目录会让那个操作悬空。

### 手动安装

也可以直接放目录：

1. **关闭 eShell**
2. 把**整个插件目录**复制到 `<storage-root>/extensions/<插件ID>/`
3. 重启桌面应用

`<storage-root>` 是**进程工作目录下的 `.eshell-data`**（`resolve_storage_root()`），
不是 AppData。`npm run tauri -- dev` 时即 `src-tauri/.eshell-data/`；打包应用从别处
启动就会落到别处——**别假设路径，先确认进程的工作目录**。

### 启用状态

持久化在 `<storage-root>/extensions/state.json`：

```json
{ "com.example.my-plugin": { "enabled": false } }
```

改这个文件要**关闭应用后改、重启生效**。运行期用设置面板切换即可，无需重启。
宿主命令是 `set_extension_enabled`（会广播 `extensions-changed`），但那是宿主管理
接口，**不在插件 facade 里**。

### 代码改动仍然需要重启

⚠️ **安装/卸载/启停是热生效的，但改插件代码不是。** 修改 `index.js`、清单或任何
相对模块后，必须重启桌面进程——**没有文件热重载**。重新安装同一个 id 可以绕过
这一点：设置里再装一次即可让新代码生效。

### 常见"插件没出现"的原因

按这个顺序排查，覆盖了绝大多数情况：

1. **改了代码但没重启**。安装/启停是热生效的，**代码变更不是**。
2. **目录放错了**。确认是这次进程实际用的 `<storage-root>`，不是仓库里的
   `extensions/builtin.json` 旁边。
3. **只复制了 `index.js`**。清单和它引用的所有相对模块/资源都要带上。
4. **`apiVersion` 不是 `1`**。不匹配直接拒绝加载。
5. **`builtin` 不是 `false`**。外部插件不能伪装成内置。
6. **面板没在清单里声明**。见 §3 的坑。
7. **用了 `npm run dev` 浏览器预览**。`plugin://` 是原生自定义协议，浏览器预览
   跑不了插件，必须 `npm run tauri -- dev` 或打包版。

每个插件独立校验：损坏的 JSON、重复 ID、不兼容版本、越界入口会被记录并跳过，
**不会让其他插件或应用启动一起失败**。

## 2. 清单 `manifest.json`

```json
{
  "id": "com.example.my-plugin",
  "displayName": "My Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "builtin": false,
  "defaultEnabled": true,
  "main": "index.js",
  "contributes": {
    "panels": [{ "id": "com.example.my-plugin.panel", "order": 30 }]
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `id` | 非空且全局唯一；**拒绝首尾空白**、`.` / `..`、路径分隔符、控制字符；建议反向域名 |
| `displayName` | 非空 |
| `version` | 非空字符串 |
| `apiVersion` | 必须为 `1`（宿主当前唯一支持值） |
| `builtin` | 外部插件**必须 `false`** |
| `defaultEnabled` | 可选，默认 `true`；持久化的用户选择优先 |
| `main` | 可选，默认 `index.js`；必须是插件目录内**实际存在**的 `.js`/`.mjs`，用 `/` 分隔符 |
| `contributes.panels` | 可选，`[{ id, order }]`；**见下方坑** |

路径以规范化后的实际文件为准，**不能通过父目录或符号链接读取插件目录之外的文件**。

## 3. 模块与生命周期

支持命名导出或默认导出激活函数：

```js
export async function activate(eshell) {
  const dispose = eshell.sftp.onTransfer((t) => eshell.log.info("transfer", t.transferId));
  return () => dispose();   // 可选清理函数
}
```

也可以 `export default function activate(eshell) { ... }`。

**启动顺序**：注册内置插件 → 读取完整目录与启用状态 → 加载并激活启用的外部插件 →
首次渲染 React。

关键约束：

- **激活超时 10 秒**（`ACTIVATION_TIMEOUT_MS`）。超时会撤销该次激活的贡献和受管
  资源，不保留半注册面板。**同上下文中的同步死循环无法被超时打断**——插件可以卡住
  整个窗口。
- 返回的清理函数在停用时调用；事件和 UI 注册函数**本身也返回幂等清理函数**，宿主
  会跟踪。主动清理后宿主再次清理不应产生副作用。
- 再次启用会**重新调用 `activate`**；ESM 模块缓存仍可复用，所以**模块顶层状态不能
  代替每次激活的资源管理**。
- 异步导入/激活有超时和迟到结果处理。超时**不等于**已终止远程执行或回滚插件自行
  产生的副作用。

### 交付格式

必须是**浏览器可执行的 ESM**，不是原始 TypeScript、JSX 或 CommonJS。

- 相对导入可用：`import { x } from "./helper.js"`
- **浏览器不能解析裸 `import "react"`**，也没有 Node 的 `fs`、`require`
- 用宿主注入的 React：`eshell.react`（见 §5）
- **不要把第二份 React 打进插件 bundle**，否则 hooks 可能与宿主 renderer 不匹配
- 大型插件可以自行构建，但产物必须包含可解析的依赖，React 用宿主实例
- 样式限定在自己的面板内；**不要依赖 eShell 私有 DOM 或覆盖全局样式**

## 4. UI 贡献

### `ui.registerPanel(panel)`

| 字段 | 说明 |
| --- | --- |
| `id` | 全局唯一面板 ID，建议带插件前缀；**不能与 `draft` 冲突** |
| `key` | 默认等于 `id` |
| `order` | 排序 |
| `title` | 面板标题 |
| `defaultVisible` | **默认 `false`（隐藏）**。显式 `true` 才会在安装后自动展开 |
| `render({ api, context, controller })` | 返回宿主 React 节点 |

### `ui.registerToolbar(item)`

`id`、`key`、`order`、`label`、`icon`，以及二选一：

- `panelId`：点击时切换该面板
- `onClick(context)`：自定义动作

#### `icon` 的三种写法

**1. 用插件自己的图**（推荐，图标跟着插件走）：

```js
icon: new URL("./icon.svg", import.meta.url).href
```

`import.meta.url` 是插件模块自己的 `plugin://` URL，所以相对路径会解析到插件目录里
的资源。协议允许的图片后缀：`png` / `jpg` / `jpeg` / `gif` / `svg` / `webp` / `ico`。
也可以传 `{ src: "..." }`。

⚠️ **只接受 `plugin://` 和 `data:image/` 开头的 URL。** `http(s):` 会被拒绝并回退到
Puzzle——否则每次渲染都会去拉一张远程图片，等于给第三方送信标。`javascript:` 同样
被拒。SVG 建议用 `stroke="currentColor"`，这样能跟随按钮的激活/悬停配色。

**2. 用宿主内置图标名**（不用带资源文件）：

```
box  boxes  cloud  container  cpu  database  git  globe  harddrive
layers  monitor  network  package  puzzle  rocket  server  shield
terminal  wrench  zap
```

大小写不敏感。**这个集合是封闭的**——不在表里的名字回退到 Puzzle，所以拼错不会让
按钮变空，但也拿不到任意图标。

**3. 传宿主 React 组件或元素**（插件自己 `import` 了图标库时）：

```js
icon: MyIconComponent
```

三种都不匹配时回退到 Puzzle。

#### 面板多了会怎样

工具栏的 **Panels** 分组是**可滚动**的：插件装多了只会在该分组内出现滚动条，
不会把下面的 Settings 挤出侧栏。所以不需要自己限制插件数量。

### `ui.registerController(hook)`

为插件注册**一个**可选 controller。它在插件自己的 React 组件中运行，接收
`{ ...context, api }`，返回值作为面板的 `controller`。多面板共享它。
**在 activate 阶段完成注册，不要在发布后替换 hook 身份。**
启停不能改变核心 workbench 的 hook 调用顺序。

### `ui.getContext()`

返回当前宿主上下文快照：`sessions`、`activeSessionId`、`activeSession`、
`disconnectedSessions`、`showPanel` / `hidePanel` / `togglePanel`。

**首次 React 挂载前上下文为空对象**——`activate` 中需要会话数据时用
`sessions.list()`，不要依赖 `ui.getContext()`。不要依赖内部 workbench 私有 setter
或组件模块。

### ⚠️ 最容易踩的坑：面板必须在清单里声明

`registerPanel` **只注册实现**。面板要真正出现在 dock 里，**必须同时在
`manifest.json` 的 `contributes.panels` 里声明**（`resolvePanelContributions` 以
清单为准，注册了但清单里没有的会排在最后兜底）。

```json
"contributes": { "panels": [{ "id": "com.example.my-plugin.panel", "order": 30 }] }
```

两处的 `id` 必须一致。**只调 `registerPanel` 不写清单 = 面板不出现。**

## 5. API 参考

除 storage、日志和注册函数外，后端操作返回 Promise。**API 不提供裸 `invoke`，
也不提供终端输入写入方法。** 输出 DTO 沿用现有 RPC 契约（见 `docs/specs/openapi.yaml`）。

### `eshell.sessions`

| 方法 | 说明 |
| --- | --- |
| `list()` | 当前会话列表 |
| `open(configId)` | 按现有配置 ID 打开会话 |
| `close(sessionId)` | 关闭指定会话 |
| `execute(sessionId, command)` | **非交互命令执行**，返回 `{ sessionId, command, stdout, stderr, exitCode, currentDir, startedAt, finishedAt, durationMs }` |
| `onOutput(cb, options?)` | 订阅终端输出 |
| `onClosed(cb, options?)` | 订阅 PTY 关闭通知 |
| `onHostKeyPrompt(cb)` | 观察主机密钥信任 challenge |

- 事件 `options` 可用 `{ sessionId }` 限定会话。
- 回调收到**经过检查的业务 payload**，不是 Tauri 事件封装。
- **原始终端输出可能包含敏感内容，不要默认记录或转发。**
- 事件过滤是调用契约，**不是隐私隔离机制**。
- `onHostKeyPrompt` 是**只读通知**，没有回复通道，不会自动信任主机密钥。连接失败
  仍正常 reject，信任确认保留在宿主流程。

`execute` 是插件唯一能跑远程命令的入口——**没有本地进程、没有 docker socket、
没有文件系统访问**。想做本地能力，只能靠 `execute` 在 SSH 会话上跑命令。

### `eshell.sftp`

`listDir` / `readFile`（返回文件信息及 `content`，**不是裸字符串**）/ `writeFile` /
`createFile` / `createDirectory` / `deleteEntry` / `renameEntry` /
`uploadLocalFile` / `downloadToLocal` / `cancelTransfer` / `defaultDownloadDir` /
`selectUploadFile(options?)` / `selectDownloadDir(defaultPathOrOptions)` /
`onTransfer(cb, options?)`。

文件选择器取消时返回 `null`。**不要通过向交互终端发送命令来替代这些接口。**

### `eshell.status`

- `fetch(sessionId, nic)` — 实况拉取
- `cached(sessionId)` — 读缓存

复用现有批量探针、超时和缓存实现。

### `eshell.config`

- `reload(file?)` — 重读磁盘上的配置文件。`file` 取 `sshConfigs` / `acpAgents` /
  `scripts` / `aiProfiles` / `agentContext`，省略则全部重载。
- `list()` — 可重载的文件列表，每项 `{ file, pathHint }`。

返回每个文件一条 `{ file, path, changed, missing, error }`：

- `changed` — 内存里的值是否真的变了
- `missing` — 文件不存在，**当前值保持不变**（不会被清空）
- `error` — 文件解析失败，**当前值保持不变**；半写入的文件不会清掉用户的服务器

**这是只读接口**：它重读用户已经写好的文件，**不返回文件内容**，所以插件拿不到 SSH
凭据。插件自己改了配置文件后，调它就能让宿主立即生效，不用让用户重启。

**重载不会重启任何东西**：已打开的 SSH 会话保持原连接（新配置对下一次连接生效），
正在运行的 ACP agent 保持启动时的设置。

`known_hosts.json` **不可重载**——它是 host key 信任库，手改后重载会让信任范围被
静默放大。

### `eshell.storage` / `log` / `meta` / `react`

```js
const old = eshell.storage.get("counter");     // JSON 读写，按插件 ID 前缀命名空间
eshell.storage.set("counter", Number(old || 0) + 1);
eshell.storage.remove("temporary-value");
eshell.log.info("ready");                       // 日志带插件来源
console.log(eshell.meta.pluginId, eshell.meta.apiVersion);
```

`eshell.react` 是**宿主 React 实例**，含 `createElement`、`useState`、`useEffect`、
`useMemo`、`useRef`、`useCallback`、`useReducer`、`useContext`、`Fragment`。

⚠️ **不要在 `activate` 里调用 hooks**——hooks 只能在面板组件或注册的 controller 里用。

storage 基于 WebView 的 localStorage，正常关闭后跨重启保留，**不是崩溃事务存储**。
不要只在最终 dispose 时才保存重要状态。因为**没有沙箱**，插件仍可绕开 facade 直接
用 localStorage；命名空间只保证正常 API 使用不会误覆盖其他插件。

## 6. 写插件的推荐结构

从 `examples/docker-plugin/` 抄这个骨架——它把可测的纯逻辑和 React 分开：

```
my-plugin/
  manifest.json
  index.js      activate + controller + 面板渲染
  logic.js      纯函数：命令构造、解析、校验、数据层（无 React、无 facade）
```

**为什么这样分**：插件代码跑在宿主上下文里，单元测试只能覆盖**不依赖 DOM 和
facade 的部分**。把命令构造、输出解析、错误分类、数据层抽成纯模块，就能用
`vitest` 直接测（见 `src/plugins/__tests__/dockerPluginExample.test.js`）。
React 部分只做渲染，异步逻辑放数据层。

要点：

- **controller 用 `useMemo` 绑定当前会话**，避免旧闭包写到新会话
- **用请求序号丢弃过期响应**（切换会话 / 连点刷新时）
- **面板渲染成纯函数**：`render({ controller })` 只读状态，不发起请求
- **失败要分类并保留原始 stderr**，用户才能判断是权限、路径还是别的问题

## 7. 调试

1. 跑 `npm run tauri -- dev`，看**带插件 ID 的控制台日志**和 native 发现日志。
2. 确认插件复制到了**这次进程实际使用的存储根**。
3. 模块加载失败时依次检查：`main`、相对导入、MIME、`apiVersion`、目录是否完整。
4. 面板不出现时，先查 §1 的排查清单，**尤其是清单里有没有声明面板**。

**普通浏览器 mock、单元测试或前端构建成功，都不能替代桌面应用里的真实验证。**
Windows 的真实自定义协议 / WebView2 加载必须在桌面应用中验证。

## 8. 当前不提供的能力

不要向用户承诺这些：

- 插件市场、签名、自动更新（安装只能从本地文件夹选）
- 代码热重载（改代码必须重启进程；安装/启停不需要）
- 沙箱或插件级权限系统
- Node 插件宿主（没有 `fs`、`require`、裸 `import`）
- 插件 facade 里的裸 `invoke`
- 终端输入写入（只能 `execute` 非交互命令）

新增宿主 API 或修改内置 Rust 实现**仍需构建应用**；外部插件本身不需要重新编译
eShell。
