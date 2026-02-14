# eShell

<p align="center">
  <img src="docs/Shell.png" alt="eShell Logo" width="180" />
</p>

eShell 是一个基于 **Tauri 2 + React + Rust** 的桌面运维工作台，交互风格参考 FinalShell。  
目标是把常见运维动作集中到一个界面内完成：`SSH`、`PTY 终端`、`SFTP`、`状态监控`、`脚本执行`、`AI 运维 Agent`。

## 功能总览

- 多 SSH 会话管理
- 基于 `xterm.js` 的 PTY 交互终端，体验接近原生 Shell
- SFTP 文件浏览与传输（左侧目录树 + 右侧目录内容）
- 文件打开/编辑弹窗，支持 Markdown 渲染与代码高亮
- 服务器状态面板（CPU / 内存 / 网卡 / 进程 / 磁盘）
- 脚本中心（保存脚本并在当前会话执行）
- AI 运维 Agent（多轮会话 + 工具调用）

## Ops Agent 能力

- 多轮对话与会话切换
- 流式输出（前端实时增量渲染）
- `read_shell`：自动执行只读诊断命令
- `write_shell`：进入待确认队列，前端审批后才执行
- AI 配置多 Profile 管理（`baseUrl/apiKey/model`）

## 技术栈

### 前端
- React 19
- Vite 7
- Tailwind CSS 4
- lucide-react
- react-markdown / remark-gfm / react-syntax-highlighter
- @xterm/xterm + @xterm/addon-fit

### 后端
- Tauri 2
- Rust
- ssh2（SSH/SFTP/PTY）
- reqwest（OpenAI-compatible API）
- serde / serde_json

## 项目结构

```text
.
├─ src/
│  ├─ components/
│  │  ├─ layout/                 # 左侧导航、顶部窗口栏
│  │  ├─ panels/                 # Terminal / SFTP / Status / AI 主面板
│  │  └─ sidebar/                # SSH/脚本/AI 配置弹窗
│  ├─ hooks/useWorkbench.js      # 前端状态与交互编排核心
│  └─ lib/tauri-api.js           # Tauri invoke 封装
├─ src-tauri/
│  ├─ src/commands.rs            # Tauri 命令入口
│  ├─ src/ssh_service.rs         # SSH/SFTP/PTY/状态采集
│  ├─ src/ops_agent/             # Ops Agent 模块（openai / service / store / types）
│  ├─ src/storage.rs             # SSH/脚本/AI 配置持久化
│  └─ src/state.rs               # 运行时会话与缓存
└─ docs/openapi.yaml             # RPC 文档（基础接口）
```

## 快速开始

### 1. 环境要求

- Node.js >= 18
- Rust stable
- Tauri 2 构建依赖

参考：<https://tauri.app/start/prerequisites/>

### 2. 安装依赖

```bash
npm install
```

### 3. 前端开发

```bash
npm run dev
```

### 4. 桌面应用开发

```bash
npm run tauri dev
```

### 5. 生产构建

```bash
npm run build
npm run tauri build
```

## 数据持久化

运行时会在当前工作目录创建 `.eshell-data/`。开发模式通常位于 `src-tauri/.eshell-data/`。

```text
.eshell-data/
├─ ssh_configs.json
├─ scripts.json
├─ ai_profiles.json
├─ ops_agent_conversation_list.json
└─ ops_agent_conversations/
   ├─ <conversationId>.json
   └─ ...
```

说明：
- `ops_agent_conversation_list.json` 存会话摘要、active 会话、pending actions
- `ops_agent_conversations/<id>.json` 存单会话完整消息
- 首条用户消息会自动生成标题：前 10 个字，超出追加 `...`
- 旧版 `ops_agent.json` / `ai_config.json` 会自动迁移并清理

## 常见问题

### 1) AI 返回 `429 Too Many Requests`
表示当前模型或 Key 当日额度耗尽。处理方式：
- 切换到其他可用模型
- 更换 API Key
- 次日再试

### 2) 看起来“后续提问没反应”
已在代码中修复流式错误事件兜底。若仍遇到：
- 检查 AI 配置是否可用（baseUrl/apiKey/model）
- 查看左侧状态栏错误信息

## 安全说明

当前本地配置（SSH 密码、AI Key）保存在 JSON 文件中，默认未做系统级加密。  
建议仅在受控环境使用；生产环境建议增加密钥管理与本地加密。

## 测试与检查

```bash
# 前端构建检查
npm run build

# 后端单元测试
cd src-tauri
cargo test
```
