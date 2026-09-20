# 外部插件开发（API v1）

外部插件是用户放入本地扩展目录的浏览器 ESM 模块。应用启动时发现清单，通过
`plugin://` 自定义协议加载代码，再调用 `activate(eshell)`。

**信任边界：插件与 eShell 共用 JS 上下文，没有沙箱，也没有插件级权限系统。**
插件可以访问 `window`、`localStorage` 和主窗口的 Tauri 能力。下面的 API 是稳定调用
契约与资源管理入口，不是阻止恶意代码的安全边界。只安装自己信任的代码。

## 1. 安装和运行示例

仓库提供两个可以直接加载的示例，都不需要安装 npm 依赖或再次打包：

- `examples/hello-plugin/` — 最小示例：相对模块导入、宿主 React、独立 controller、
  会话查询、命名空间存储。
- `examples/docker-plugin/` — 完整示例：异步会话命令、错误分类、纯逻辑模块 + 单元
  测试、插件自带图标。

### 从设置面板安装（推荐）

**设置 → 插件 → 从文件夹安装…**，选中插件目录即可。应用会把它复制到
`<storage-root>/extensions/<清单 id>/` 并**立即生效，无需重启**。目标目录名取自清单
的 `id`，不是源文件夹名。

安装走和启动扫描完全相同的校验（清单可解析、`apiVersion` 匹配、`builtin: false`、
`main` 在目录内）。校验不通过会在复制之前拒绝，不会留下半个插件。覆盖安装同一个 id
是升级路径；旧副本先移开，复制失败会还原。

### 手动安装

关闭 eShell，把整个目录复制到：

```text
<storage-root>/extensions/com.example.hello/
  manifest.json
  index.js
  message.js
```

常规 `npm run tauri -- dev` 使用的目录通常是：

```text
src-tauri/.eshell-data/extensions/com.example.hello/
```

随后重新启动桌面应用，Hello Plugin 面板及工具栏入口会出现。

### 生效规则

⚠️ **安装、卸载、启用/停用是热生效的；修改插件代码不是。** 改动 `index.js`、清单或
任何相对模块后必须重启桌面进程——没有文件热重载。想省掉重启，可以在设置里对同一个
id 重新安装一次。

注意：

- 当前存储根仍是进程工作目录下的 `.eshell-data`，没有迁到 AppData。
- 单独的 `npm run dev` 浏览器预览没有原生插件协议，不能代替 Tauri 运行验证。
- 只复制 `index.js` 不够，必须包含清单与它引用的所有相对模块/资源。
- 外部插件不需要重新编译 eShell；新增宿主 API 或修改内置 Rust 实现仍需构建应用。

## 2. 清单

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
| `id` | 非空且全局唯一；拒绝首尾空白、`.` / `..`、路径分隔符及控制字符，不能与内置或其他插件重复；建议反向域名形式 |
| `displayName` | 插件展示名称 |
| `version` | 插件实现版本字符串 |
| `apiVersion` | 必须为宿主支持的版本，目前为 `1`；不匹配时拒绝加载 |
| `builtin` | 外部插件必须为 `false`，不能伪装成内置插件 |
| `defaultEnabled` | 可选，默认 `true`；持久化的用户选择优先 |
| `main` | 可选，默认 `index.js`；必须是插件目录内实际存在的模块 |
| `contributes.panels` | 可选，预声明面板 ID 和排序；实现仍需在 activate 中注册 |

每个插件独立校验。损坏的 JSON、重复 ID、不兼容版本和越界入口会被记录并跳过，
不会让其他插件或应用启动一起失败。路径以规范化后的实际文件为准，不能通过父目录
或符号链接读取插件目录之外的文件。

清单中的 `main` 是相对路径，不是 `file://` URL。后端返回适合当前平台的模块 URL：
Windows 形如 `http://plugin.localhost/<id>/index.js`。资源协议校验每一个请求，并设置
ESM 需要的 MIME/CORS 响应；未知文件和不允许的资源类型不会按任意本地文件读取。

## 3. 模块与生命周期

支持命名导出或默认导出激活函数：

```js
export async function activate(eshell) {
  const dispose = eshell.sftp.onTransfer((transfer) => {
    eshell.log.info("transfer", transfer.transferId, transfer.stage);
  });
  return () => dispose();
}
```

也可以写 `export default function activate(eshell) { ... }`。
返回的可选函数是本次激活的清理函数。事件和 UI 注册函数本身也返回幂等清理函数，
宿主会跟踪这些资源；主动清理后，宿主再次清理不应产生副作用。

启动顺序为：注册内置插件 → 读取完整目录与启用状态 → 加载并激活启用的外部插件 →
首次渲染 React。激活失败会撤销该次激活的贡献和受管资源，不保留半注册面板。

运行期停用时调用插件清理函数、释放 API 订阅并注销贡献。再次启用会重新调用
`activate`；ESM 模块缓存仍可复用，所以模块顶层状态不能代替每次激活的资源管理。

异步导入/激活等待有超时和迟到结果处理。**同上下文中的同步死循环无法被超时打断**；
插件可以卡住整个窗口。超时也不等于已经终止远程执行或回滚插件自行产生的副作用。

## 4. JavaScript、React 与依赖

交付文件必须是浏览器可执行的 ESM，不是原始 TypeScript、JSX 或 CommonJS。
相对导入可以使用，例如 `import { title } from "./message.js"`。
浏览器不能解析裸 `import "react"`，也没有 Node 的 `fs`、`require` 等环境。

使用宿主注入的 React：

```js
export function activate(eshell) {
  const { createElement: h, useState } = eshell.react;
  // 在面板组件或注册的 controller 中使用 hooks，不要在 activate 中调用 hooks。
}
```

不要把第二份 React 打进插件 bundle，否则 hooks 可能与宿主 renderer 不匹配。
大型插件可以自行构建，但最终产物必须包含可解析的依赖，React 则使用宿主实例。
插件自己的样式应限定在自己的面板内；不要依赖 eShell 私有 DOM 或覆盖全局样式。
示例复用现有主题语义 class，没有新增主题色。

## 5. API 参考

除 storage、日志和注册函数外，后端操作返回 Promise。API 不提供裸 `invoke` 或
终端输入写入方法。输出 DTO 沿用对应的现有 RPC 契约，见
[OpenAPI-style RPC Spec](../../specs/openapi.yaml)。

### 会话

- `sessions.list()`：当前会话列表。
- `sessions.open(configId)`：按现有配置 ID 打开会话。
- `sessions.close(sessionId)`：关闭指定会话。
- `sessions.execute(sessionId, command)`：非交互命令执行，返回 stdout/stderr/退出码等。
- `sessions.onOutput(callback, options?)`：显式订阅终端输出。
- `sessions.onClosed(callback, options?)`：订阅 PTY 关闭通知。
- `sessions.onHostKeyPrompt(callback)`：观察主机密钥信任 challenge。

事件 `options` 可用 `{ sessionId }` 限定会话；只有具有对应会话字段的事件才适用。
回调收到经过检查的业务 payload，不是 Tauri 事件封装。原始终端输出可能包含敏感内容，
不要默认记录或转发。事件过滤是调用契约，不是隐私隔离机制。

主机密钥 challenge 原来是连接失败的错误数据，不是 `ssh-ki-prompt` 事件。
宿主桥在展示该 challenge 或 SDK open 报告该错误时发送只读通知；它不等于键盘交互式
密码/2FA 提示，也不会自动信任主机密钥。连接失败仍正常 reject，信任确认保留在宿主流程。

### SFTP

- `sftp.listDir(sessionId, path)`
- `sftp.readFile(sessionId, path)`：返回文件信息及 `content`，不是裸字符串。
- `sftp.writeFile(sessionId, path, content)`
- `sftp.createFile(sessionId, path)`
- `sftp.createDirectory(sessionId, path)`
- `sftp.deleteEntry(sessionId, path, entryType)`
- `sftp.renameEntry(sessionId, path, newName)`
- `sftp.uploadLocalFile(sessionId, remotePath, localPath, transferId, localName)`
- `sftp.downloadToLocal(sessionId, remotePath, localDir, transferId)`
- `sftp.cancelTransfer(transferId)`
- `sftp.defaultDownloadDir()`
- `sftp.selectUploadFile(options?)`：本地文件选择，取消返回 `null`。
- `sftp.selectDownloadDir(defaultPathOrOptions)`：接受目录字符串或 `{ defaultPath, title }`，取消返回 `null`。
- `sftp.onTransfer(callback, options?)`：传输事件；可按 `sessionId` 过滤。

文件选择 options 可包含本地化的 `title`。传输阶段、取消语义和部分文件清理仍由现有
SFTP 服务负责，不要通过向交互终端发送命令来替代这些接口。

### 状态监控

- `status.fetch(sessionId, nic)`
- `status.cached(sessionId)`

复用当前批量探针、超时和缓存实现。API 门面迁移不会把现有串行轮询改回重叠计时器。

### 配置重载

- `config.reload(file?)`：重读磁盘上的配置文件。`file` 取 `sshConfigs`、`acpAgents`、
  `scripts`、`aiProfiles`、`agentContext`；省略则全部重载。
- `config.list()`：可重载的文件列表，每项 `{ file, pathHint }`。

返回每个文件一条 `{ file, path, changed, missing, error }`。`missing` 表示文件不存在，
`error` 表示解析失败——两种情况都**保持当前值不变**，所以半写入的文件不会清掉用户的
服务器。`changed` 表示内存里的值确实变了。

**这是只读接口**：它重读用户已经写好的文件，不返回文件内容，所以插件拿不到 SSH
凭据。插件自己改了配置文件后调它，宿主立即生效，不需要用户重启。

**重载不会重启任何东西**：已打开的 SSH 会话保持原连接（新配置对下一次连接生效），
正在运行的 ACP agent 保持启动时的设置。`known_hosts.json` 不可重载——它是 host key
信任库，手改后重载会让信任范围被静默放大。

### UI 贡献

`ui.registerPanel(panel)` 支持：

- `id`：全局唯一面板 ID，建议带插件前缀；不能与 `sftp`、`status`、`draft` 冲突。
- `key`：默认等于 ID。
- `order`、`title`、`defaultVisible`。**默认 `false`（隐藏）**：安装一个插件不应该
  打乱用户的 dock 布局，而且面板可见性不持久化，所以自动展开的面板每次启动都会再
  展开一次。显式写 `defaultVisible: true` 才是「装完就显示」的请求。
- `render({ api, context, controller })`：返回宿主 React 节点。

`ui.registerToolbar(item)` 支持 `id`、`key`、`order`、`label`、`icon`，以及：

- `panelId`：点击时切换该面板。
- `onClick(context)`：自定义动作。

#### `icon` 的三种写法

**1. 插件自带的图**（推荐，图标跟着插件走）：

```js
icon: new URL("./icon.svg", import.meta.url).href
```

`import.meta.url` 是插件模块自己的 `plugin://` URL，相对路径因此解析到插件目录内的
资源。协议允许的图片后缀：`png` / `jpg` / `jpeg` / `gif` / `svg` / `webp` / `ico`。
也可以传 `{ src: "..." }`。

⚠️ **只接受 `plugin://` 和 `data:image/` 开头的 URL。** `http(s):` 会被拒绝并回退到
Puzzle——否则每次渲染都会去拉一张远程图片，等于给第三方送信标。`javascript:` 同样
被拒。SVG 建议用 `stroke="currentColor"`，这样能跟随按钮的激活/悬停配色。

**2. 宿主内置图标名**（不用带资源文件）：

```
box  boxes  cloud  container  cpu  database  git  globe  harddrive
layers  monitor  network  package  puzzle  rocket  server  shield
terminal  wrench  zap
```

大小写不敏感。**这个集合是封闭的**：不在表里的名字回退到 Puzzle，所以拼错不会让按钮
变空，但也拿不到任意图标。

**3. 宿主 React 组件或元素**（插件自己 import 了图标库时）。

三种都不匹配时回退到 Puzzle。

#### 面板多了会怎样

工具栏的 **Panels** 分组是可滚动的：插件装多了只在该分组内出现滚动条，不会把下面的
Settings 挤出侧栏。插件不需要自己限制数量。

`ui.registerController(hook)` 为插件注册一个可选 controller。它在插件自己的 React
组件中运行，接收 `{ ...context, api }`，返回值作为面板的 `controller`。一个插件只
注册一个 controller，多面板共享它；在 activate 阶段完成注册，不在发布后替换 hook 身份。
启停不能改变核心 workbench 的 hook 调用顺序。

`ui.getContext()` 返回当前宿主上下文，包括会话列表、当前会话 ID/会话，以及面板
show/hide/toggle 操作。首次 React 挂载前上下文为空，activate 中需要会话数据时应使用
`sessions.list()`。不要依赖内部 workbench 私有 setter 或组件模块。

### 存储、日志与元信息

```js
const oldValue = eshell.storage.get("counter");
eshell.storage.set("counter", Number(oldValue || 0) + 1);
eshell.storage.remove("temporary-value");
eshell.log.info("ready");
eshell.log.warn("unexpected input");
eshell.log.error("operation failed");
console.log(eshell.meta.pluginId, eshell.meta.apiVersion);
```

storage 使用插件 ID 前缀保存 JSON，与启用状态文件不同。因为没有沙箱，插件仍可以
绕开 facade 直接使用 localStorage；命名空间只保证正常 API 使用不会误覆盖其他插件。
日志包含插件来源。不要在日志中打印密码、私钥或终端中的敏感内容。

此存储基于 WebView 的 localStorage，正常关闭后可跨重启保留，不是崩溃事务存储。
不要把强制终止进程或断电时的落盘保证当作 API 契约，也不要只在最终 dispose 时才保存重要状态。

## 6. 安装、启用、停用和持久化

### 设置面板

**设置 → 插件**列出全部内置 + 外部扩展，每行可以启用/禁用。外部插件还可以从文件夹
安装、以及移除（二次确认）。内置扩展只能禁用，不能移除——它们的代码随应用发布。

- **安装**：复制到 `extensions/<清单 id>/` 并重扫目录，立即生效。
- **移除**：删除插件目录并清除它的启用状态记录，同样立即生效。
- **在途操作会阻止移除**：插件持有 lease 时删除目录会让那个操作悬空，所以会被拒绝。
- **重扫不会静默改变启用状态**：用户关掉的插件不会因为一次重扫被重新打开。

### 手动编辑状态文件

用户选择保存到 `<storage-root>/extensions/state.json`：

```json
{
  "com.example.my-plugin": { "enabled": false }
}
```

编辑已有文件时保留其他条目。关闭应用后修改，重新启动生效；不是配置热重载。
运行期由宿主的 `set_extension_enabled` 命令进行修改并广播 `extensions-changed`。
此命令是宿主管理接口，不是插件 facade 中的裸 invoke 能力。

- 持久化失败时不能声称修改成功，运行期状态保持原值。
- API 操作的调用方插件持有原生 lease；存在在途操作时停用会被拒绝。
- SFTP/监控提供者自身的已有 lease 同时保留。
- 这只是生命周期与 busy 管理，不是调用者身份鉴权。
- 停用不会关闭用户已有的 SSH 会话；隐藏面板也不等于停用插件。
- 禁用的插件启动时不执行模块代码。删除插件目录后，清单和面板不再出现。

## 7. 调试和限制

先运行 `npm run tauri -- dev`，检查带插件 ID 的控制台日志与 native 发现日志。
确认插件复制到了这次进程实际使用的存储根，而不是仓库的 `extensions/builtin.json`
旁边。遇到模块加载失败，检查 main、相对导入、MIME、API 版本和完整目录结构。

面板不出现时，先确认清单的 `contributes.panels` 里声明了它——`registerPanel` 只注册
实现，面板要出现在 dock 里必须同时在清单里声明。

本阶段没有插件市场、签名、自动更新或沙箱，也没有要求安装新的 Node 插件宿主。
**安装/卸载/启停是热生效的，但代码变更不是**——改插件源码仍需重启桌面进程。
Windows 的真实自定义协议/WebView2 加载需要在桌面应用中验证；普通浏览器 mock、
单元测试或前端构建成功，不能替代这一步。
