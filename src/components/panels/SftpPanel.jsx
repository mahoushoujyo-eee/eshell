import SplitPane from "../SplitPane";

export default function SftpPanel({
  activeSessionId,
  currentPath,
  refreshSftp,
  uploadFile,
  downloadFile,
  selectedEntry,
  segments,
  sftpEntries,
  openEntry,
  openFilePath,
  dirtyFile,
  openFileContent,
  onOpenFileContentChange,
  formatBytes,
}) {
  return (
    <div className="h-full rounded-xl border border-border/90 bg-panel p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">SFTP 浏览与编辑</div>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            className="rounded border border-border px-2 py-1"
            onClick={() => refreshSftp(currentPath)}
            disabled={!activeSessionId}
          >
            刷新
          </button>
          <label className="cursor-pointer rounded border border-border px-2 py-1">
            上传
            <input type="file" className="hidden" onChange={uploadFile} disabled={!activeSessionId} />
          </label>
          <button
            type="button"
            className="rounded border border-border px-2 py-1"
            onClick={downloadFile}
            disabled={!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory"}
          >
            下载
          </button>
        </div>
      </div>
      <SplitPane
        direction="horizontal"
        initialRatio={0.33}
        minPrimarySize={150}
        minSecondarySize={220}
        primary={
          <div
            className="h-full rounded-md border border-border/80 bg-surface p-2 text-xs"
            onContextMenu={(event) => {
              event.preventDefault();
              refreshSftp(currentPath);
            }}
          >
            {segments.map((segment) => (
              <button
                key={segment.path}
                type="button"
                className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent-soft"
                onClick={() => refreshSftp(segment.path)}
              >
                {segment.label}
              </button>
            ))}
          </div>
        }
        secondary={
          <div className="h-full overflow-hidden text-xs">
            <div className="mb-1 rounded-md border border-border/80 bg-surface px-2 py-1 text-muted">
              路径: {currentPath}
            </div>
            <div className="h-[38%] overflow-auto rounded-md border border-border/80 bg-surface">
              {sftpEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={[
                    "flex w-full items-center justify-between border-b border-border/50 px-2 py-1.5 text-left hover:bg-accent-soft",
                    selectedEntry?.path === entry.path ? "bg-accent-soft" : "",
                  ].join(" ")}
                  onClick={() => openEntry(entry)}
                >
                  <span className="truncate">
                    {entry.entryType === "directory" ? "📁" : "📄"} {entry.name}
                  </span>
                  <span className="text-[10px] text-muted">
                    {entry.entryType === "directory" ? "-" : formatBytes(entry.size)}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-1 h-[calc(62%-0.25rem)] overflow-hidden rounded-md border border-border/80 bg-surface p-1">
              <div className="mb-1 text-[10px] text-muted">
                {openFilePath || "未选择文件"} {dirtyFile ? "(未保存)" : ""}
              </div>
              <textarea
                className="h-[calc(100%-1.2rem)] w-full resize-none rounded border border-border bg-panel px-2 py-1 font-mono text-xs"
                value={openFileContent}
                disabled={!openFilePath}
                onChange={(event) => onOpenFileContentChange(event.target.value)}
              />
            </div>
          </div>
        }
      />
    </div>
  );
}
