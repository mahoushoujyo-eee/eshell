# eShell Codex

`eShell Codex` 是一个基于 `Tauri 2 + React + Tailwind CSS` 的桌面运维工具，整体交互参考 FinalShell，面向日常 SSH 运维、SFTP 文件操作、脚本执行和 AI 辅助分析场景。

## 核心能力

- SSH 配置管理：支持新增、编辑、删除、持久化存储。
- 多会话终端：支持多个会话标签页并行操作，互不干扰。
- SFTP 浏览与传输：左侧目录树（仅目录）懒加载，右侧目录内容实时展示，支持上传、下载、远程文件打开与编辑。
- 文件编辑弹窗：支持 Markdown 预览与多语言语法高亮（如 YAML/JSON/Bash/Rust 等）。
- 服务器状态监控：CPU、内存、网卡流量、Top 进程、磁盘占用，支持周期刷新与会话缓存。
- 脚本中心：脚本定义管理与会话内一键执行。
- AI 助手：兼容 OpenAI 协议（可配置 `baseUrl/apiKey/model`），支持结合终端输出来提问和命令建议回填。

## 技术栈

- 桌面框架：`Tauri 2`
- 前端：`React 19`、`Vite 7`、`Tailwind CSS 4`
- 图标与渲染：`lucide-react`、`react-markdown`、`react-syntax-highlighter`
- 后端：`Rust`
- SSH / SFTP：`ssh2`
- HTTP / AI 调用：`reqwest`
- 数据序列化：`serde`、`serde_json`

## 项目结构

```text
.
├─ src/                       # React 前端
│  ├─ components/
│  │  ├─ layout/              # 左侧导航与工具栏
│  │  ├─ panels/              # Terminal / SFTP / Status / AI 等主面板
│  │  └─ sidebar/             # SSH/脚本/AI 配置弹窗
│  ├─ hooks/useWorkbench.js   # 前端核心状态与交互编排
│  └─ lib/tauri-api.js        # Tauri invoke API 封装
├─ src-tauri/                 # Rust + Tauri 后端
│  ├─ src/commands.rs         # 命令入口（Tauri command）
│  ├─ src/ssh_service.rs      # SSH/SFTP/状态采集核心逻辑
│  ├─ src/ai_service.rs       # AI 调用逻辑
│  ├─ src/storage.rs          # JSON 持久化
│  └─ src/state.rs            # 运行时会话与状态缓存
└─ docs/openapi.yaml          # RPC 接口文档（OpenAPI）
```

## 快速开始

### 1) 环境要求

- Node.js `>= 18`
- Rust（建议 stable）
- Tauri 2 构建依赖（Windows/macOS/Linux 按官方文档安装）

参考：<https://tauri.app/start/prerequisites/>

### 2) 安装依赖

```bash
npm install
```

### 3) 前端开发（仅 Web）

```bash
npm run dev
```

### 4) 桌面应用开发（Tauri）

```bash
npm run tauri dev
```

### 5) 构建

```bash
npm run build
npm run tauri build
```

## 数据存储说明

后端会在运行目录下自动创建 `.eshell-data` 目录并维护以下文件：

- `ssh_configs.json`：SSH 配置
- `scripts.json`：脚本定义
- `ai_config.json`：AI 配置

在当前项目开发模式下，通常位于 `src-tauri/.eshell-data/`。

## 接口文档

- OpenAPI 文档：`docs/openapi.yaml`
- 接口域：`ssh`、`shell`、`sftp`、`status`、`scripts`、`ai`

## 测试与检查

前端构建检查：

```bash
npm run build
```

后端单元测试（当前主要覆盖存储层）：

```bash
cd src-tauri
cargo test
```

## 安全与使用建议

- 当前 SSH 密码与 AI Key 以明文形式存储在本地 JSON 文件中，建议仅在受控环境使用。
- 生产环境建议补充：本地敏感信息加密（系统密钥链或加密存储）、更严格的主机校验策略、操作审计与最小权限控制。
