# eShell

一个现代化的 SSH 终端和服务器管理工具，采用 Tauri v2 + React 构建，旨在提供类似 FinalShell 的功能体验，并集成 AI 辅助能力。

## ✨ 主要特性

### 🖥️ SSH 终端
- 完整的 SSH 连接支持
- 基于 xterm.js 的终端模拟器
- 多标签页管理
- 连接会话持久化

### 📊 系统监控
- **资源监控**：实时显示远程服务器的 CPU、内存使用情况
- **网络监控**：实时网卡流量监控（上传/下载速度）
- **进程管理**：显示 TOP 5 进程，包含 PID、CPU%、内存使用、进程名

### 📁 文件管理
- SFTP 文件浏览器
- 目录树导航
- 文件上传/下载
- 文件重命名/删除
- 新建文件夹
- 右键菜单操作

### 🔧 服务器管理
- SSH 主机配置管理
- 编辑/删除已保存的连接
- 快速连接历史服务器

### 📝 脚本与命令
- **脚本管理器**：内置常用运维脚本（系统信息、网络检查、Docker 状态等）
- **命令编辑器**：多行命令编辑，支持 Ctrl+Enter 快速执行
- 命令历史记录（最近 20 条）

### 🤖 AI 助手
- 集成 AI 辅助功能（开发中）
- 智能命令建议

## 🛠️ 技术栈

### 前端
- **框架**：React 18
- **构建工具**：Vite
- **UI 组件**：Ant Design
- **样式**：Tailwind CSS v4
- **状态管理**：Zustand
- **终端模拟**：xterm.js + xterm-addon-fit

### 后端
- **框架**：Tauri v2
- **语言**：Rust
- **SSH 库**：ssh2
- **序列化**：serde, serde_json

## 🚀 开始使用

### 环境要求

- Node.js 16+
- Rust 1.70+
- pnpm/npm/yarn

### 安装依赖

```bash
# 安装前端依赖
npm install

# 或使用 pnpm
pnpm install
```

### 开发模式

```bash
npm run tauri dev
```

### 构建应用

```bash
npm run tauri build
```

构建完成后，可执行文件位于 `src-tauri/target/release/` 目录。

## 📖 使用说明

### 连接服务器

1. 点击顶部 "Servers" 按钮
2. 点击 "Add Server" 添加新服务器
3. 填写服务器信息：
   - 名称
   - 主机地址
   - 端口（默认 22）
   - 用户名
   - 密码
4. 点击连接

### 文件管理

- 在底部 "Files" 标签页中浏览远程文件
- 左侧目录树导航，右侧文件列表
- 右键点击目录可刷新
- 支持文件上传、下载、重命名、删除等操作

### 执行脚本

1. 切换到 "Scripts" 标签页
2. 选择预设脚本或自定义脚本
3. 点击 "Run Selected" 执行

### 命令编辑器

1. 切换到 "Commands" 标签页
2. 输入命令（支持多行）
3. 按 Ctrl+Enter 执行
4. 查看历史命令记录

## 🎨 界面预览

- **左侧栏**：服务器列表、AI 助手、系统监控、进程列表
- **主区域**：SSH 终端
- **底部栏**：文件管理、脚本管理、命令编辑器（三个标签页）
- **右侧栏**（可选）：AI 助手面板

## 📝 配置文件

应用配置保存在系统默认配置目录：
- Windows: `%APPDATA%\com.eshell.dev\config.json`
- macOS: `~/Library/Application Support/com.eshell.dev/config.json`
- Linux: `~/.config/com.eshell.dev/config.json`

配置文件包含：
- SSH 连接会话
- 自定义脚本

## 🔒 安全说明

- 密码使用明文存储在本地配置文件中（未来版本将支持加密）
- SSH 连接使用 ssh2 库提供的安全加密通道
- 建议仅在受信任的设备上使用

## 🗺️ 开发计划

- [ ] 密码加密存储
- [ ] SSH 密钥认证支持
- [ ] AI 助手功能完善
- [ ] 主题自定义
- [ ] 更多内置脚本
- [ ] 文件编辑器集成
- [ ] 多语言支持

## BUG清单

- [ ] 网卡切换后会自动切换回默认网卡
- [ ] 初次连接时，各类资源加载会阻塞页面操作
- [ ] 

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 开源协议

MIT License

## 👤 作者

mahoushoujyo-eee

## 🙏 致谢

- [Tauri](https://tauri.app/) - 跨平台桌面应用框架
- [xterm.js](https://xtermjs.org/) - 终端模拟器
- [Ant Design](https://ant.design/) - UI 组件库
- [ssh2](https://docs.rs/ssh2/) - Rust SSH 库
