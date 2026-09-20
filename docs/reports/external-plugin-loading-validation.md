# 外部插件路线 A：实现与验证记录

日期：2026-09-18 至 2026-09-19  
计划：[external-plugin-loading.md](../plans/external-plugin-loading.md)  
接口约定：[external-plugin-contract.md](../plans/external-plugin-contract.md)

## 实现范围

- 从当前存储根的 `extensions/*/manifest.json` 发现可信浏览器 ESM 插件。
- 原生 `plugin://` 协议提供 JS/相对模块/允许的静态资源，校验入口、ID、API 版本及规范路径。
- API-v1 门面覆盖会话、SFTP、状态、UI、命名空间存储和日志；内置 SFTP/status 使用该门面。
- 外部面板、工具栏和每激活实例独立的 React controller，无需增加宿主 ID 分支。
- 启用状态持久化、调用方和提供者的 lease、写失败回滚、受管资源清理及启动/启停竞态处理。
- 可直接复制运行的 `examples/hello-plugin/` 和插件开发指南。

沿用同 JS 上下文信任模型，没有沙箱、插件级鉴权、市场、签名、热重载或 Node 宿主。
数据根仍跟随进程 cwd，不在本次迁移中改变。

## 基线与工作区保护

本轮基线是**开工时的工作区**，不是 Git HEAD：工作区已经包含前一轮内置插件迁移、
连接提示修复，以及用户新增的串行监控轮询、批量探针和 20 秒超时。

- 开工基线：116 项前端测试通过，Vite 构建和 `cargo check` 通过。
- 当前工作区构建副本保存于系统 temp 中的 `eshell-external-plugin-baseline-V0uTOY/dist`。
- 现有未提交内容保留，没有自动 commit、reset、checkout 或 restore。
- 没有读取或修改用户的 `runs.json`、真实 SSH 凭据或真实 `.eshell-data`。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| 完整前端测试 | 205 passed，22 个测试文件，exit 0 |
| Rust 编译检查 | 通过，保留 5 个原有 library warnings |
| Rust 单元/本地集成测试 | 281 passed，0 failed，1 个原有 live AI smoke ignore |
| Vite 生产构建 | 通过，保留原有大 chunk 警告 |
| Tauri `build --debug --no-bundle` | 最终构建通过，产出包含目录读取与无-controller面板修复的生产 origin 调试 exe |
| 贡献点解析 | `src/plugins/contributions.js` 与本轮工作区基线逐字节一致 |
| API 访问边界 | `src/plugins/` 生产模块无直接 Tauri / tauri-api import；测试 mock 不计 |
| RPC 文档 | YAML 解析通过，50 个路径 |

测试覆盖清单默认值（包括合法 `defaultEnabled:false`）、版本/ID 冲突、路径逃逸、
调用方 busy lease、持久化失败回滚、异步 listener 注册、迟到激活/disposer、启动时
catalog 竞态、相同 ID 快速重启、StrictMode controller store，以及现有工作台功能。

验证中发现并修复过两类假阳性风险：

- 仅看断言数量全绿不足以认定成功：测试清理曾产生未捕获的 React scheduler 异常，
  已修复卸载/flush 顺序，最终以进程 exit 0 且无 unhandled error 为准。
- SFTP 门面替换曾遗漏目录读取回调的 `current` 局部变量。浏览器完整交互发现后，
  已补绑定及真实 `requestSftpDir` / `refreshSftp` 回归断言；插件源文件的未绑定变量检查通过。

## 内置功能浏览器对照

用相同的确定性 Tauri mock，在 Edge 中分别驱动本轮基线构建和修复后的构建：

- 前后各完成 25 个交互场景、30 项 DOM 断言。
- 前后均无页面异常、console error 或 console warning。
- 覆盖 SFTP/status/draft 组合、KeepAlive、会话/NIC 切换、GPU、文件编辑和二进制保护、
  上传/下载队列、重命名/新建/删除、终端断线重连、配置、设置和 AI dock。
- 每轮保存 26 张截图，主要 SFTP/status 画面已人工查看；13 张 PNG 逐字节一致。
  其他画面涉及动态指标、提示消失和过渡时序，不声称任意时刻的全部像素完全相等。

证据位于系统 temp 的 `eshell-external-ui-qlxBow/`：
`baseline-complete-run/` 与 `postfix-run/`。这是**真实前端 + 模拟后端**验证，
不能替代下面的原生协议验证或真实 SSH 主机测试。

## 真实 Tauri / WebView2

已完成候选程序的 V1–V7：20/20 检查通过，生产 origin 为 `http://tauri.localhost`，
没有浏览器后端 mock，也没有真实 SSH 连接。覆盖：

- 自定义协议的 JS MIME/CORS、相对导入和越界请求拒绝。
- hello 插件面板、工具栏、宿主 React controller 与计数器。
- 点击计数跨进程重启保留。
- 启用/停用触发 activate/dispose，停用跨重启保留。
- 删除插件目录后重启无清单或 UI 残留。
- 损坏 JSON、不兼容 API 版本、越界 main 被独立跳过。

**最终原生验证：22/22 检查通过，0 页面异常，3 次正常窗口关闭。** 主进程使用更小的
独立驱动对最终构建重新验证，报告在系统 temp 的
`eshell-native-verified-YM0pvV/report.json`，截图已人工查看。

额外覆盖并通过：

- 合法 `defaultEnabled:false` 插件仍被列出，但模块顶层与 activate 均不执行。
- 缺省 `defaultEnabled` 默认为 true，简单面板无需 controller 也能立即显示。
- 持久化 true 在重启后覆盖清单中的 false；hello 重新启用后计数器保留。
- 在**同一个已发现进程**内，分别把 extensions 根和已注册插件目录换成 Windows junction：
  已存在的 victim `index.js` 与 outside JSON 请求均被 403 拒绝，不返回 marker。
- 换链前和恢复后，原模块均为 200；junction 目标内容未被改动，删除插件再启动无残留。

验证发现并修复了一个真实运行期问题：可选 controller 缺席时，面板曾错误地一直等待
不存在的 controller store。现在只对确实注册了 controller 的插件等待首个快照，
无 controller 的面板使用就绪的空 controller 输出，并有两个回归测试覆盖。

测试方法也进行了校正：未知 ID 的 404 不能证明目录锚点正确，换链后重启进程也不是
运行期锚点测试，因此最终使用已注册 ID、实际存在的目标文件、同进程换链与恢复阳性对照。
存储持久化按正常窗口关闭后重启验证；强制终止 WebView2 可能丢失尚未落盘的 localStorage，
不把强杀进程等同于正常重启，也不声称 localStorage 具有崩溃事务持久性。

所有原生场景使用独立 temp cwd 和 WebView2 profile；只清理本次启动的进程树，
不改变用户应用/profile。证据不作为仓库运行依赖，系统 temp 清理后可能不再保留。

## 未覆盖的边界

- 真实 SSH 主机的认证、网络故障、大文件传输和原生文件选择器仍需授权主机联调。
- 本机验证平台为 Windows；macOS/Linux 未做桌面运行验证。
- 同上下文的同步死循环不能被异步超时打断；不提供恶意插件隔离保证。
