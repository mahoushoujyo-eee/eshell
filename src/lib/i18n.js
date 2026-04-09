import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "eshell:locale";

const zhMessages = {
  "Active": "启用中",
  "Actions for {name}": "{name} 的操作",
  "Add selected shell content to Ops Agent": "将选中的 Shell 内容添加到 Ops Agent",
  "Add To Agent": "添加到 Agent",
  "Agent": "助手",
  "Agent typing": "助手正在输入",
  "AI Configs": "AI 配置",
  "AI config": "AI 配置",
  "AI response": "AI 回复",
  "and all of its messages will be removed permanently.": "及其所有消息都将被永久删除。",
  "and everything inside it will be removed from the remote server immediately.":
    "以及其中的所有内容都会立即从远端服务器删除。",
  "approval required": "需要审批",
  "Approve": "批准",
  "Approve command": "批准命令",
  "Ask the ops agent about diagnostics, root cause, or safe commands...":
    "向运维助手询问诊断、根因分析或安全命令……",
  "awaiting approval": "等待审批",
  "Aurora Grid": "极光网格",
  "Back": "返回",
  "Background warning": "后台警告",
  "Base URL": "基础 URL",
  "Blueprint": "蓝图",
  "Blur wallpaper under the terminal text for readability.":
    "在终端文字下方模糊壁纸，以提升可读性。",
  "Cancelled": "已取消",
  "Cancellation requested": "已请求取消",
  "Cancel": "取消",
  "Chat Execution Error": "会话执行错误",
  "Change": "修改",
  "Close": "关闭",
  "Close AI chat": "关闭 AI 对话",
  "Close session": "关闭会话",
  "Close session {name}": "关闭会话 {name}",
  "Collapse sidebar": "收起侧边栏",
  "Command": "命令",
  "Compact conversation": "压缩会话",
  "Compacting conversation": "正在压缩会话",
  "Config": "配置",
  "Config name": "配置名称",
  "Configured: {count}": "已配置：{count}",
  "Connect": "连接",
  "Connect a session first": "请先连接会话",
  "Connected to {name} ({dir})": "已连接到 {name}（{dir}）",
  "Connecting to {target}...": "正在连接到 {target}……",
  "Connecting...": "连接中……",
  "Connect SSH first": "请先连接 SSH",
  "Conversation compaction finished.": "会话压缩已完成。",
  "Conversation: {title}": "会话：{title}",
  "Copy": "复制",
  "Copied": "已复制",
  "Copy latest AI reply": "复制最新 AI 回复",
  "CPU": "CPU",
  "Create AI conversation": "创建 AI 会话",
  "Create Config": "创建配置",
  "Create Script": "创建脚本",
  "Create Server": "创建服务器",
  "Crop And Scale": "裁剪与缩放",
  "Cropping dialog is open. Source {width} x {height}":
    "裁剪对话框已打开。源图尺寸 {width} x {height}",
  "Current": "当前",
  "Custom Image": "自定义图片",
  "Custom uploaded image. Stored locally in this app session.":
    "自定义上传图片，仅保存在当前应用环境中。",
  "Custom Wallpaper": "自定义壁纸",
  "Dark Mode": "深色模式",
  "Delete": "删除",
  "Deleted {name}": "已删除 {name}",
  "Delete AI config": "删除 AI 配置",
  "Delete conversation": "删除会话",
  "Delete remote file": "删除远端文件",
  "Delete script": "删除脚本",
  "Delete SSH config": "删除 SSH 配置",
  "Delete this conversation?": "要删除这个会话吗？",
  "Delete this remote file?": "要删除这个远端文件吗？",
  "Delete this remote folder?": "要删除这个远端文件夹吗？",
  "Detail Focus": "细节视图",
  "Deleting...": "删除中……",
  "Discard": "丢弃",
  "Disks": "磁盘",
  "Dismiss": "关闭",
  "Double-click to open": "双击打开",
  "Download": "下载",
  "Download Dir: {path}": "下载目录：{path}",
  "Download file": "下载文件",
  "Edit": "编辑",
  "Edit config": "编辑配置",
  "Edit script": "编辑脚本",
  "Edit server": "编辑服务器",
  "Enabled": "启用",
  "executed": "已执行",
  "Expand sidebar": "展开侧边栏",
  "Failed": "失败",
  "Failed to apply cropped wallpaper.": "应用裁剪后的壁纸失败。",
  "Failed to connect to {target}: {reason}": "连接到 {target} 失败：{reason}",
  "Failed to import wallpaper.": "导入壁纸失败。",
  "Failed to render crop preview.": "生成裁剪预览失败。",
  "File Actions": "文件操作",
  "File details": "文件详情",
  "File Editor": "文件编辑器",
  "Folder Actions": "文件夹操作",
  "Forest Haze": "林雾",
  "Frosted Glass": "磨砂玻璃",
  "Hide AI chat": "隐藏 AI 对话",
  "Hide chat history": "隐藏聊天记录",
  "Hide model reasoning": "隐藏模型推理",
  "Hide SFTP panel": "隐藏 SFTP 面板",
  "Hide status panel": "隐藏状态面板",
  "Hide tool details": "隐藏工具详情",
  "Host": "主机",
  "Horizontal": "水平",
  "Idle": "空闲",
  "Importing...": "导入中……",
  "In Use": "使用中",
  "Light Mode": "浅色模式",
  "Language": "语言",
  "Language: {language}": "语言：{language}",
  "Live diagnostics and guided actions": "实时诊断与引导式操作",
  "Local: {path}": "本地：{path}",
  "Manage model profiles and pick one for conversation.":
    "管理模型配置，并为当前会话选择使用的配置。",
  "Manage scripts and execute them in the active SSH session.":
    "管理脚本，并在当前 SSH 会话中执行。",
  "Manage server profiles and connect quickly.": "管理服务器配置并快速连接。",
  "Max context tokens": "最大上下文 Token",
  "Max tokens": "最大 Token",
  "Maximize": "最大化",
  "Memory (GB)": "内存（GB）",
  "Memory (MB)": "内存（MB）",
  "Minimize": "最小化",
  "Model": "模型",
  "New": "新建",
  "New Config": "新建配置",
  "New config": "新建配置",
  "New conversation": "新建会话",
  "New Script": "新建脚本",
  "New script": "新建脚本",
  "New Server": "新建服务器",
  "New server": "新建服务器",
  "Network": "网络",
  "No active conversation": "当前没有活跃会话",
  "No active sessions": "当前没有活跃会话",
  "No AI configs yet.": "还没有 AI 配置。",
  "No AI profile": "暂无 AI 配置",
  "No conversations yet": "还没有会话",
  "No disk data": "没有磁盘数据",
  "No issues": "没有问题",
  "No messages": "没有消息",
  "No process data": "没有进程数据",
  "No scripts yet.": "还没有脚本。",
  "No server profiles yet.": "还没有服务器配置。",
  "No shell session selected": "未选择 Shell 会话",
  "No status data": "没有状态数据",
  "No transfer tasks yet.": "还没有传输任务。",
  "Only image files are supported.": "仅支持图片文件。",
  "Open": "打开",
  "Open file as text?": "要按文本方式打开这个文件吗？",
  "Open Folder": "打开文件夹",
  "Opening...": "打开中……",
  "Open SSH session": "打开 SSH 会话",
  "Operation Complete": "操作完成",
  "Operation Error": "操作错误",
  "Operation Update": "操作更新",
  "Operation Warning": "操作警告",
  "Operations Console": "运维控制台",
  "Ops Agent": "运维助手",
  "Password": "密码",
  "Panels": "面板",
  "Password": "密码",
  "Path": "路径",
  "Path: {path}": "路径：{path}",
  "Pending": "待处理",
  "Pending tool approvals": "待审批工具操作",
  "Plain Terminal": "纯净终端",
  "Please connect an SSH session first": "请先连接 SSH 会话",
  "Please set a local download directory first": "请先设置本地下载目录",
  "Port": "端口",
  "Preset wallpaper tuned for PTY readability and visible contrast.":
    "针对 PTY 可读性和对比度优化的预设壁纸。",
  "Presets": "预设",
  "Preview": "预览",
  "Processes": "进程",
  "PTY connected. Type directly in terminal.": "PTY 已连接，可以直接在终端中输入。",
  "Queued": "排队中",
  "Quick": "快捷",
  "Read directory": "读取目录",
  "Read file": "读取文件",
  "Recent issue": "最近问题",
  "Refresh": "刷新",
  "Reject": "拒绝",
  "Reject command": "拒绝命令",
  "Remove Custom": "移除自定义",
  "Remove selected shell context": "移除选中的 Shell 上下文",
  "Replace Image": "替换图片",
  "requested": "已请求",
  "Reset": "重置",
  "Restore": "还原",
  "Run": "运行",
  "Run command": "运行命令",
  "Running: {busy}": "运行中：{busy}",
  "Run command": "运行命令",
  "Run script": "运行脚本",
  "Save AI config": "保存 AI 配置",
  "Save script": "保存脚本",
  "Save SSH config": "保存 SSH 配置",
  "Script Center": "脚本中心",
  "Script has no runnable command or path": "脚本没有可执行命令或路径",
  "Script name": "脚本名称",
  "Script not found": "未找到脚本",
  "Script path": "脚本路径",
  "Scripts": "脚本",
  "Selected file": "已选文件",
  "Server Status": "服务器状态",
  "Session disconnected. Auto-reconnected.": "会话已断开，已自动重连。",
  "Set local download directory": "设置本地下载目录",
  "Set local download folder": "设置本地下载文件夹",
  "Shell": "Shell",
  "Shell Context / {name}": "Shell 上下文 / {name}",
  "Show AI chat": "显示 AI 对话",
  "Show chat history": "显示聊天记录",
  "Show model reasoning": "显示模型推理",
  "Show SFTP panel": "显示 SFTP 面板",
  "Show status panel": "显示状态面板",
  "Show tool details": "显示工具详情",
  "Single-click selects. Double-click opens. Right-click for actions.":
    "单击选择，双击打开，右键查看更多操作。",
  "Size: {size}": "大小：{size}",
  "SSH Profiles": "SSH 配置",
  "SSH Servers": "SSH 服务器",
  "Start a conversation about ops troubleshooting, diagnostics, or safe command planning.":
    "开始一段关于运维排障、诊断分析或安全命令规划的对话。",
  "Stop": "停止",
  "Sunset Ridge": "落日山脊",
  "Switch AI profile": "切换 AI 配置",
  "Switch to {language}": "切换到 {language}",
  "System prompt": "系统提示词",
  "Temperature": "温度",
  "Terminal Wallpaper": "终端壁纸",
  "Text Editor Check": "文本编辑器检查",
  "This file is larger than 50 MB and may be slow to load in the text editor.":
    "该文件大于 50 MB，在文本编辑器中加载可能较慢。",
  "This file looks like a common binary format, so the content may be unreadable as text.":
    "该文件看起来像常见二进制格式，按文本打开可能无法阅读。",
  "Toggle transfer queue": "切换传输队列",
  "Tool": "工具",
  "Total RX {rx} / Total TX {tx}": "总接收 {rx} / 总发送 {tx}",
  "Transfer cancelled": "传输已取消",
  "Transfer Queue": "传输队列",
  "Transferring": "传输中",
  "Transfers": "传输",
  "Untitled conversation": "未命名会话",
  "unknown": "未知",
  "Update Config": "更新配置",
  "Update Script": "更新脚本",
  "Update Server": "更新服务器",
  "Upload": "上传",
  "Upload a JPG, PNG, or WebP under 1.5MB, then crop and scale before applying.":
    "上传小于 1.5MB 的 JPG、PNG 或 WebP 图片，应用前可先裁剪和缩放。",
  "Upload file": "上传文件",
  "Upload Wallpaper": "上传壁纸",
  "Use": "使用",
  "Use an image smaller than 1.5MB.": "请使用小于 1.5MB 的图片。",
  "used": "已用",
  "Username": "用户名",
  "Vertical": "垂直",
  "Wallpaper": "壁纸",
  "Wallpaper: {label}": "壁纸：{label}",
  "Warning: Server status polling failed for this cycle due to a transient network fluctuation. The app will retry automatically.":
    "警告：本轮服务器状态轮询因临时网络波动失败，应用会自动重试。",
  "will be removed from the remote server immediately.": "会立即从远端服务器删除。",
  "You": "你",
  "Zoom": "缩放",
  " / Esc to close": " / 按 Esc 关闭",
  ".{extension} is a common binary format, so the content may be unreadable as text.":
    ".{extension} 是常见的二进制格式，按文本打开可能无法阅读。",
  "(not set)": "（未设置）",
  "(Synced)": "（已同步）",
  "(Unsaved)": "（未保存）",
  "Applying...": "应用中……",
  "Apply Wallpaper": "应用壁纸",
  "Collapse {name}": "折叠 {name}",
  "Confirm Delete": "确认删除",
  "Expand {name}": "展开 {name}",
  "Failed to decode image.": "解码图片失败。",
  "Failed to read image.": "读取图片失败。",
  "Loading project": "加载项目中",
  "may not be a good fit for the built-in text editor.": "可能并不适合内置文本编辑器。",
  "Open Anyway": "仍然打开",
  "Pick a preset or upload your own background for the PTY terminal.":
    "选择一个预设，或为 PTY 终端上传自己的背景图。",
  "PTY input sender is not ready": "PTY 输入发送器尚未就绪",
  "Resize AI panel": "调整 AI 面板宽度",
  "SFTP Browser": "SFTP 浏览器",
  "Send": "发送",
  "Shell session lost and cannot auto-reconnect: {sessionId}":
    "Shell 会话已丢失，且无法自动重连：{sessionId}",
  "Source {width} x {height} | Export {outWidth} x {outHeight}":
    "源图 {width} x {height} | 导出 {outWidth} x {outHeight}",
  "think": "思考",
  "English": "English",
  "简体中文": "简体中文",
};

const defaultContextValue = {
  language: "en",
  localeTag: "en-US",
  setLanguage: () => {},
  toggleLanguage: () => {},
  t: (source, vars) => interpolate(source, vars),
};

const I18nContext = createContext(defaultContextValue);

function normalizeLanguage(value) {
  return String(value || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function detectInitialLanguage() {
  if (typeof window === "undefined") {
    return "en";
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    return normalizeLanguage(stored);
  }

  return normalizeLanguage(window.navigator?.language || "en");
}

function interpolate(source, vars = {}) {
  const template = String(source ?? "");
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function I18nProvider({ children }) {
  const [language, setLanguage] = useState(detectInitialLanguage);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, language);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    }
  }, [language]);

  const value = useMemo(() => {
    const localeTag = language === "zh" ? "zh-CN" : "en-US";
    return {
      language,
      localeTag,
      setLanguage: (nextLanguage) => setLanguage(normalizeLanguage(nextLanguage)),
      toggleLanguage: () =>
        setLanguage((current) => (current === "zh" ? "en" : "zh")),
      t: (source, vars = {}) => {
        const normalizedSource = String(source ?? "");
        const translated =
          language === "zh" ? zhMessages[normalizedSource] || normalizedSource : normalizedSource;
        return interpolate(translated, vars);
      },
    };
  }, [language]);

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n() {
  return useContext(I18nContext);
}
