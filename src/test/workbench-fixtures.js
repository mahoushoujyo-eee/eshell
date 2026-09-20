/**
 * Deterministic fixtures for the SFTP / status / workspace baseline tests,
 * mirroring the shapes `useWorkbench` produces (v1.5.5). The tests exist to
 * keep that behavior identical through the UI migration.
 */
import { vi } from "vitest";

export const formatBytes = (size) => {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const display = value / 1024 ** index;
  return `${display.toFixed(display >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

export const SFTP_ENTRIES = [
  { path: "/var/log", name: "log", entryType: "directory", size: 0, modifiedAt: 1700000000 },
  { path: "/var/backup", name: "backup", entryType: "directory", size: 0, modifiedAt: 1700000001 },
  { path: "/var/app.log", name: "app.log", entryType: "file", size: 4096, modifiedAt: 1700000100 },
  { path: "/var/.env", name: ".env", entryType: "file", size: 24, modifiedAt: 1700000200 },
  { path: "/var/bundle.tar.gz", name: "bundle.tar.gz", entryType: "file", size: 80, modifiedAt: 1700000300 },
  { path: "/var/readme.md", name: "readme.md", entryType: "file", size: 2048, modifiedAt: 1700000400 },
];

export const SFTP_TRANSFERS = [
  {
    transferId: "t-download-1",
    direction: "download",
    fileName: "app.log",
    remotePath: "/var/app.log",
    localPath: "C:/Users/user/Downloads/app.log",
    stage: "progress",
    percent: 42,
    transferredBytes: 1700,
    totalBytes: 4096,
  },
  {
    transferId: "t-upload-1",
    direction: "upload",
    fileName: "dump.sql",
    remotePath: "/var/dump.sql",
    stage: "queued",
    percent: 0,
    transferredBytes: 0,
    totalBytes: 1048576,
  },
  {
    transferId: "t-done-1",
    direction: "download",
    fileName: "old.log",
    remotePath: "/var/old.log",
    stage: "completed",
    percent: 100,
    transferredBytes: 1024,
    totalBytes: 1024,
  },
  {
    transferId: "t-fail-1",
    direction: "upload",
    fileName: "broken.bin",
    remotePath: "/var/broken.bin",
    stage: "failed",
    percent: 13,
    transferredBytes: 13,
    totalBytes: 100,
    message: "Permission denied",
  },
];

export const STATUS_SNAPSHOT = {
  cpuPercent: 12.5,
  memory: { usedMb: 2048, totalMb: 8192, usedPercent: 25 },
  disks: [
    { filesystem: "/dev/sda1", mountPoint: "/", used: "20G", total: "80G", usedPercent: "25%" },
    { filesystem: "/dev/sda2", mountPoint: "/data", used: "76G", total: "80G", usedPercent: "95%" },
  ],
  gpus: [
    {
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      temperatureC: 61,
      fanPercent: 43,
      utilizationPercent: 37,
      memoryUsedMb: 10240,
      memoryTotalMb: 24576,
      powerDrawW: 210,
      powerLimitW: 450,
      processes: [
        { pid: 4242, command: "python train.py", memoryMb: 9216 },
        { pid: 4243, command: "python eval.py", memoryMb: 1024 },
      ],
    },
  ],
  topProcesses: [
    { pid: 42, command: "node server.js", cpuPercent: 3.2, memoryMb: 128 },
    { pid: 7, command: "systemd", cpuPercent: 0.1, memoryMb: 12.4 },
  ],
  networkInterfaces: [{ interface: "eth0" }, { interface: "lo" }],
  selectedInterface: "eth0",
  selectedInterfaceTraffic: { interface: "eth0", rxBytes: 1024, txBytes: 512 },
  fetchedAt: "2026-09-18T08:00:00.000Z",
};

/**
 * The builtin extension manifest shape (`extensions/builtin.json`): sftp at
 * order 10, server-monitor at order 20, both enabled. Bottom-panel layout
 * tests pass this through the workbench so the migrated `AppMainWorkspace`
 * resolves its panels the way the app root does.
 */
export const BUILTIN_EXTENSIONS = [
  {
    id: "eshell.sftp",
    displayName: "SFTP",
    version: "1.0.0",
    apiVersion: 1,
    builtin: true,
    enabled: true,
    contributes: { panels: [{ id: "sftp", order: 10 }] },
  },
  {
    id: "eshell.server-monitor",
    displayName: "Server Monitor",
    version: "1.0.0",
    apiVersion: 1,
    builtin: true,
    enabled: true,
    contributes: { panels: [{ id: "status", order: 20 }] },
  },
];

export function makeWorkbench(overrides = {}) {
  const toggle = (current) => current;
  return {
    theme: "dark",
    setTheme: vi.fn(),
    wallpaper: null,
    setWallpaper: vi.fn(),
    extensions: BUILTIN_EXTENSIONS,
    showSftpPanel: false,
    setShowSftpPanel: vi.fn(toggle),
    showStatusPanel: false,
    setShowStatusPanel: vi.fn(toggle),
    showCommandDraftPanel: false,
    setShowCommandDraftPanel: vi.fn(toggle),
    statusRefreshInterval: 5000,
    setStatusRefreshInterval: vi.fn(),
    showAiPanel: false,
    setShowAiPanel: vi.fn(),
    busy: "",
    error: "",
    uiNotices: [],
    dismissUiNotice: vi.fn(),
    activeSessionId: "session-alpha",
    setActiveSessionId: vi.fn(),
    activeSession: {
      id: "session-alpha",
      configId: "cfg-1",
      configName: "prod-box",
      currentDir: "/var",
    },
    commandDraft: "",
    setCommandDraft: vi.fn((value) => value),
    downloadDirectory: "/home/user/downloads",
    sftpTransfers: [],
    currentPath: "/var",
    currentStatus: null,
    currentNic: null,
    sftpEntries: SFTP_ENTRIES,
    selectedEntry: null,
    sessions: [
      { id: "session-alpha", configId: "cfg-1", configName: "prod-box", currentDir: "/var" },
    ],
    closeSession: vi.fn(async () => true),
    reopenSessionPty: vi.fn(async () => true),
    disconnectedSessions: {},
    sendCommandDraft: vi.fn(async () => true),
    sendPtyInput: vi.fn(),
    resizePty: vi.fn(),
    uploadFile: vi.fn(async () => {}),
    createSftpEntry: vi.fn(async () => true),
    downloadFile: vi.fn(async () => {}),
    deleteSftpEntry: vi.fn(async () => true),
    renameSftpEntry: vi.fn(async () => true),
    copySftpEntryPath: vi.fn(async () => {}),
    cancelSftpTransfer: vi.fn(),
    requestSftpDir: vi.fn(async (path) => ({ path, entries: SFTP_ENTRIES })),
    refreshSftp: vi.fn(async (path) => ({ path, entries: SFTP_ENTRIES })),
    openEntry: vi.fn(async () => ({ opened: true })),
    selectSftpEntry: vi.fn(),
    handleNicChange: vi.fn(),
    handleDownloadDirectoryChange: vi.fn(),
    formatBytes,
    ...overrides,
  };
}

export function makeAcp(overrides = {}) {
  return {
    turnActive: false,
    attachShellContext: vi.fn(),
    ...overrides,
  };
}

export function makeUi(overrides = {}) {
  return {
    sidebarCollapsed: false,
    onToggleSidebarCollapsed: vi.fn(),
    onOpenSshConfig: vi.fn(),
    onOpenScriptConfig: vi.fn(),
    onOpenWallpaperPicker: vi.fn(),
    onOpenAgentConfig: vi.fn(),
    onOpenSettings: vi.fn(),
    workspaceRef: { current: null },
    aiPanelWidth: 380,
    isAiPanelResizing: false,
    onStartAiPanelResize: vi.fn(),
    isFileEditorOpen: false,
    onOpenFileEditor: vi.fn(),
    onCloseFileEditor: vi.fn(),
    ...overrides,
  };
}
