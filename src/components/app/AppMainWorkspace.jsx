import { useRef } from "react";
import KeepAlive from "../KeepAlive";
import SplitPane from "../SplitPane";
import CommandDraftPanel from "../panels/CommandDraftPanel";
import SftpPanel from "../panels/SftpPanel";
import StatusPanel from "../panels/StatusPanel";
import TerminalPanel from "../panels/TerminalPanel";

export default function AppMainWorkspace({
  workbench,
  acp,
  showSftpPanel,
  showStatusPanel,
  showCommandDraftPanel,
  onOpenFileEditor,
}) {
  const {
    activeSessionId,
    setActiveSessionId,
    activeSession,
    commandDraft,
    setCommandDraft,
    downloadDirectory,
    sftpTransfers,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    sessions,
    wallpaper,
    closeSession,
    reconnectSession,
    disconnectedSessions,
    sendCommandDraft,
    sendPtyInput,
    resizePty,
    uploadFile,
    createSftpEntry,
    downloadFile,
    deleteSftpEntry,
    renameSftpEntry,
    copySftpEntryPath,
    cancelSftpTransfer,
    setShowAiPanel,
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    handleNicChange,
    handleDownloadDirectoryChange,
    formatBytes,
    statusRefreshInterval,
    setStatusRefreshInterval,
  } = workbench;

  // Stable slot nodes — one per panel, created once and never re-created.
  // KeepAlive moves each panel's host node into its slot when visible; layout
  // below only arranges slot mount points, so panel trees never unmount.
  const sftpSlotRef = useRef(null);
  const statusSlotRef = useRef(null);
  const draftSlotRef = useRef(null);
  if (sftpSlotRef.current === null && typeof document !== "undefined") {
    sftpSlotRef.current = document.createElement("div");
    sftpSlotRef.current.className = "h-full w-full";
  }
  if (statusSlotRef.current === null && typeof document !== "undefined") {
    statusSlotRef.current = document.createElement("div");
    statusSlotRef.current.className = "h-full w-full";
  }
  if (draftSlotRef.current === null && typeof document !== "undefined") {
    draftSlotRef.current = document.createElement("div");
    draftSlotRef.current.className = "h-full w-full";
  }

  const terminalPanel = (
    <TerminalPanel
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={setActiveSessionId}
      onCloseSession={closeSession}
      onReconnectSession={reconnectSession}
      disconnectedSessions={disconnectedSessions}
      activeSession={activeSession}
      onPtyInput={sendPtyInput}
      onPtyResize={resizePty}
      onAttachSelectionToAi={(selection) => {
        acp.attachShellContext(selection);
        setShowAiPanel(true);
      }}
      wallpaper={wallpaper}
    />
  );

  const bottomPanels = [
    {
      key: "sftp",
      visible: showSftpPanel,
      slotRef: sftpSlotRef,
      node: (
        <SftpPanel
          activeSessionId={activeSessionId}
          currentPath={currentPath}
          requestSftpDir={requestSftpDir}
          refreshSftp={refreshSftp}
          uploadFile={uploadFile}
          createSftpEntry={createSftpEntry}
          downloadFile={downloadFile}
          deleteSftpEntry={deleteSftpEntry}
          renameSftpEntry={renameSftpEntry}
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
      ),
    },
    {
      key: "status",
      visible: showStatusPanel,
      slotRef: statusSlotRef,
      node: (
        <StatusPanel
          activeSessionId={activeSessionId}
          currentStatus={currentStatus}
          currentNic={currentNic}
          onNicChange={handleNicChange}
          formatBytes={formatBytes}
          refreshInterval={statusRefreshInterval}
          onRefreshIntervalChange={setStatusRefreshInterval}
        />
      ),
    },
    {
      key: "draft",
      visible: showCommandDraftPanel,
      slotRef: draftSlotRef,
      node: (
        <CommandDraftPanel
          activeSessionId={activeSessionId}
          draft={commandDraft}
          onDraftChange={setCommandDraft}
          onSend={sendCommandDraft}
        />
      ),
    },
  ];

  const visibleBottomPanels = bottomPanels.filter((panel) => panel.visible);
  const visibleCount = visibleBottomPanels.length;

  // Layout: arrange stable slot mount points. Each mount point is a plain
  // wrapper div rendered by React; the persistent slot node is moved into it
  // via callback ref. When React unmounts the wrapper (layout change), the
  // slot is detached with it — but the slot node itself survives in the ref
  // and is re-attached to the next wrapper, so panel content is never lost.
  const mountSlot = (slotRef) => (wrapper) => {
    if (wrapper && slotRef.current && slotRef.current.parentNode !== wrapper) {
      wrapper.appendChild(slotRef.current);
    }
  };

  const slotElement = (panel) => (
    <div key={panel.key} ref={mountSlot(panel.slotRef)} className="h-full w-full" />
  );

  let bottomPanelsContent = null;
  if (visibleCount === 1) {
    bottomPanelsContent = slotElement(visibleBottomPanels[0]);
  } else if (visibleCount === 2) {
    bottomPanelsContent = (
      <SplitPane
        direction="horizontal"
        initialRatio={0.58}
        minPrimarySize={420}
        minSecondarySize={280}
        primary={slotElement(visibleBottomPanels[0])}
        secondary={slotElement(visibleBottomPanels[1])}
      />
    );
  } else if (visibleCount === 3) {
    bottomPanelsContent = (
      <SplitPane
        direction="horizontal"
        initialRatio={0.58}
        minPrimarySize={420}
        minSecondarySize={280}
        primary={slotElement(visibleBottomPanels[0])}
        secondary={
          <SplitPane
            direction="horizontal"
            initialRatio={0.58}
            minPrimarySize={280}
            minSecondarySize={220}
            primary={slotElement(visibleBottomPanels[1])}
            secondary={slotElement(visibleBottomPanels[2])}
          />
        }
      />
    );
  }

  return (
    <>
      {/* Panel component trees live in portals here; they never unmount. */}
      {bottomPanels.map((panel) => (
        <KeepAlive key={panel.key} active={panel.visible} slotRef={panel.slotRef}>
          {panel.node}
        </KeepAlive>
      ))}
      <div className="flex h-full min-h-0 flex-1 flex-col">
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
      </div>
    </>
  );
}
