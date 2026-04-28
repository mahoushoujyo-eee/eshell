import SplitPane from "../SplitPane";
import SftpPanel from "../panels/SftpPanel";
import StatusPanel from "../panels/StatusPanel";
import TerminalPanel from "../panels/TerminalPanel";

export default function AppMainWorkspace({
  workbench,
  showSftpPanel,
  showStatusPanel,
  onOpenFileEditor,
}) {
  const {
    activeSessionId,
    setActiveSessionId,
    activeSession,
    commandInput,
    setCommandInput,
    downloadDirectory,
    sftpTransfers,
    currentPtyOutput,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    sessions,
    wallpaper,
    closeSession,
    execCommand,
    sendPtyInput,
    resizePty,
    uploadFile,
    createSftpEntry,
    downloadFile,
    deleteSftpEntry,
    copySftpEntryPath,
    cancelSftpTransfer,
    attachAiShellContext,
    setShowAiPanel,
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    handleNicChange,
    handleDownloadDirectoryChange,
    formatBytes,
  } = workbench;

  const terminalPanel = (
    <TerminalPanel
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={setActiveSessionId}
      onCloseSession={closeSession}
      activeSession={activeSession}
      commandInput={commandInput}
      setCommandInput={setCommandInput}
      onExecCommand={execCommand}
      currentPtyOutput={currentPtyOutput}
      onPtyInput={sendPtyInput}
      onPtyResize={resizePty}
      onAttachSelectionToAi={(selection) => {
        attachAiShellContext(selection);
        setShowAiPanel(true);
      }}
      wallpaper={wallpaper}
    />
  );

  const sftpPanel = (
    <SftpPanel
      activeSessionId={activeSessionId}
      currentPath={currentPath}
      requestSftpDir={requestSftpDir}
      refreshSftp={refreshSftp}
      uploadFile={uploadFile}
      createSftpEntry={createSftpEntry}
      downloadFile={downloadFile}
      deleteSftpEntry={deleteSftpEntry}
      copySftpEntryPath={copySftpEntryPath}
      cancelTransfer={cancelSftpTransfer}
      downloadDirectory={downloadDirectory}
      onDownloadDirectoryChange={handleDownloadDirectoryChange}
      transfers={sftpTransfers}
      selectedEntry={selectedEntry}
      sftpEntries={sftpEntries}
      openEntry={openEntry}
      selectSftpEntry={selectSftpEntry}
      onOpenFileEditor={onOpenFileEditor}
      formatBytes={formatBytes}
    />
  );

  const statusPanel = showStatusPanel ? (
    <StatusPanel
      activeSessionId={activeSessionId}
      currentStatus={currentStatus}
      currentNic={currentNic}
      onNicChange={handleNicChange}
      formatBytes={formatBytes}
    />
  ) : null;

  let bottomPanelsContent = null;
  if (showSftpPanel && statusPanel) {
    bottomPanelsContent = (
      <SplitPane
        direction="horizontal"
        initialRatio={0.58}
        minPrimarySize={420}
        minSecondarySize={280}
        primary={sftpPanel}
        secondary={statusPanel}
      />
    );
  } else if (showSftpPanel) {
    bottomPanelsContent = sftpPanel;
  } else if (statusPanel) {
    bottomPanelsContent = statusPanel;
  }

  return (
    <SplitPane
      direction="vertical"
      initialRatio={0.5}
      minPrimarySize={290}
      minSecondarySize={280}
      collapseSecondary={!bottomPanelsContent}
      collapsedSecondarySize={0}
      primary={terminalPanel}
      secondary={<section className="h-full">{bottomPanelsContent}</section>}
    />
  );
}
