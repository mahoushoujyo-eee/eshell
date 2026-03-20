import { useEffect, useRef, useState } from "react";
import SplitPane from "./components/SplitPane";
import TopToolbar from "./components/layout/TopToolbar";
import WindowTitleBar from "./components/layout/WindowTitleBar";
import AiAssistantPanel from "./components/panels/AiAssistantPanel";
import FileEditorModal from "./components/panels/FileEditorModal";
import SftpPanel from "./components/panels/SftpPanel";
import StatusPanel from "./components/panels/StatusPanel";
import TerminalPanel from "./components/panels/TerminalPanel";
import AiConfigModal from "./components/sidebar/AiConfigModal";
import ScriptConfigModal from "./components/sidebar/ScriptConfigModal";
import SshConfigModal from "./components/sidebar/SshConfigModal";
import WallpaperModal from "./components/sidebar/WallpaperModal";
import { getWallpaperLabel } from "./constants/workbench";
import { useWorkbench } from "./hooks/useWorkbench";

const DEFAULT_AI_PANEL_WIDTH = 460;
const MIN_AI_PANEL_WIDTH = 360;
const MAX_AI_PANEL_WIDTH = 760;
const MIN_MAIN_WORKSPACE_WIDTH = 420;

const clampAiPanelWidth = (width, containerWidth = 0) => {
  const numericWidth = Number(width);
  const safeWidth = Number.isFinite(numericWidth) ? numericWidth : DEFAULT_AI_PANEL_WIDTH;
  if (!containerWidth || containerWidth <= 0) {
    return Math.min(MAX_AI_PANEL_WIDTH, Math.max(MIN_AI_PANEL_WIDTH, safeWidth));
  }

  const maxByContainer = Math.max(320, containerWidth - MIN_MAIN_WORKSPACE_WIDTH);
  const maxWidth = Math.min(MAX_AI_PANEL_WIDTH, maxByContainer);
  const minWidth = Math.min(MIN_AI_PANEL_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, safeWidth));
};

function App() {
  const [isSshModalOpen, setIsSshModalOpen] = useState(false);
  const [isScriptModalOpen, setIsScriptModalOpen] = useState(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [isFileEditorOpen, setIsFileEditorOpen] = useState(false);
  const [isWallpaperModalOpen, setIsWallpaperModalOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("eshell:sidebar-collapsed") === "1";
  });
  const [aiPanelWidth, setAiPanelWidth] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_AI_PANEL_WIDTH;
    }

    const stored = Number(window.localStorage.getItem("eshell:ai-panel-width"));
    return clampAiPanelWidth(stored);
  });
  const [isAiPanelResizing, setIsAiPanelResizing] = useState(false);
  const workspaceRef = useRef(null);

  const {
    theme,
    setTheme,
    wallpaper,
    setWallpaper,
    showSftpPanel,
    setShowSftpPanel,
    showStatusPanel,
    setShowStatusPanel,
    showAiPanel,
    setShowAiPanel,
    busy,
    error,
    sshConfigs,
    sshForm,
    setSshForm,
    scripts,
    scriptForm,
    setScriptForm,
    sessions,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    commandInput,
    setCommandInput,
    currentPtyOutput,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    openFilePath,
    dirtyFile,
    openFileContent,
    aiProfiles,
    activeAiProfileId,
    aiProfileForm,
    setAiProfileForm,
    aiQuestion,
    setAiQuestion,
    aiConversations,
    activeAiConversationId,
    activeAiConversation,
    aiPendingActions,
    isAiStreaming,
    aiStreamingText,
    resolvingAiActionId,
    saveSsh,
    connectServer,
    closeSession,
    execCommand,
    sendPtyInput,
    resizePty,
    uploadFile,
    downloadFile,
    saveScript,
    runScript,
    saveAiProfile,
    selectAiProfile,
    deleteAiProfile,
    selectAiConversation,
    createAiConversation,
    deleteAiConversation,
    resolveAiPendingAction,
    askAi,
    requestSftpDir,
    refreshSftp,
    openEntry,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    formatBytes,
  } = useWorkbench();

  useEffect(() => {
    if (!showAiPanel) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setShowAiPanel(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showAiPanel, setShowAiPanel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:ai-panel-width", String(Math.round(aiPanelWidth)));
  }, [aiPanelWidth]);

  useEffect(() => {
    const syncWidth = () => {
      const containerWidth = workspaceRef.current?.clientWidth || 0;
      setAiPanelWidth((current) => clampAiPanelWidth(current, containerWidth));
    };

    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, []);

  useEffect(() => {
    if (!isAiPanelResizing) {
      return undefined;
    }

    const onMouseMove = (event) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const nextWidth = rect.right - event.clientX;
      setAiPanelWidth(clampAiPanelWidth(nextWidth, rect.width));
    };

    const onMouseUp = () => {
      setIsAiPanelResizing(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isAiPanelResizing]);

  const sftpPanel = (
    <SftpPanel
      activeSessionId={activeSessionId}
      currentPath={currentPath}
      requestSftpDir={requestSftpDir}
      refreshSftp={refreshSftp}
      uploadFile={uploadFile}
      downloadFile={downloadFile}
      selectedEntry={selectedEntry}
      sftpEntries={sftpEntries}
      openEntry={openEntry}
      onOpenFileEditor={() => setIsFileEditorOpen(true)}
      formatBytes={formatBytes}
    />
  );

  const statusPanel = (
    <StatusPanel
      activeSessionId={activeSessionId}
      currentStatus={currentStatus}
      currentNic={currentNic}
      onNicChange={handleNicChange}
      formatBytes={formatBytes}
    />
  );

  const aiPanel = (
    <AiAssistantPanel
      aiProfiles={aiProfiles}
      activeAiProfileId={activeAiProfileId}
      onSelectAiProfile={selectAiProfile}
      conversations={aiConversations}
      activeConversationId={activeAiConversationId}
      activeConversation={activeAiConversation}
      onCreateConversation={createAiConversation}
      onSelectConversation={selectAiConversation}
      onDeleteConversation={deleteAiConversation}
      pendingActions={aiPendingActions}
      onResolvePendingAction={resolveAiPendingAction}
      resolvingActionId={resolvingAiActionId}
      aiQuestion={aiQuestion}
      setAiQuestion={setAiQuestion}
      isStreaming={isAiStreaming}
      streamingText={aiStreamingText}
      onAskAi={askAi}
      onOpenAiConfig={() => setIsAiModalOpen(true)}
      onClose={() => setShowAiPanel(false)}
      variant="dock"
    />
  );

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
      wallpaper={wallpaper}
    />
  );

  const rightPanelsContent = showStatusPanel ? statusPanel : null;

  let bottomPanelsContent = null;
  if (showSftpPanel && rightPanelsContent) {
    bottomPanelsContent = (
      <SplitPane
        direction="horizontal"
        initialRatio={0.58}
        minPrimarySize={420}
        minSecondarySize={280}
        primary={sftpPanel}
        secondary={rightPanelsContent}
      />
    );
  } else if (showSftpPanel) {
    bottomPanelsContent = sftpPanel;
  } else if (rightPanelsContent) {
    bottomPanelsContent = rightPanelsContent;
  }

  const mainWorkspaceContent = bottomPanelsContent ? (
    <SplitPane
      direction="vertical"
      initialRatio={0.5}
      minPrimarySize={290}
      minSecondarySize={280}
      primary={terminalPanel}
      secondary={<section className="h-full">{bottomPanelsContent}</section>}
    />
  ) : (
    <section className="h-full">{terminalPanel}</section>
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden text-text">
      <WindowTitleBar
        showAiPanel={showAiPanel}
        onToggleAiPanel={() => setShowAiPanel((prev) => !prev)}
        isAiStreaming={isAiStreaming}
      />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-panel">
        <TopToolbar
          theme={theme}
          wallpaperLabel={getWallpaperLabel(wallpaper)}
          showSftpPanel={showSftpPanel}
          showStatusPanel={showStatusPanel}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
          onOpenSshConfig={() => setIsSshModalOpen(true)}
          onOpenScriptConfig={() => setIsScriptModalOpen(true)}
          onOpenAiConfig={() => setIsAiModalOpen(true)}
          onOpenWallpaperPicker={() => setIsWallpaperModalOpen(true)}
          onToggleSftpPanel={() => setShowSftpPanel((prev) => !prev)}
          onToggleStatusPanel={() => setShowStatusPanel((prev) => !prev)}
          onToggleTheme={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
          busy={busy}
          error={error}
        />

        <div ref={workspaceRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {mainWorkspaceContent}
          </div>

          <button
            type="button"
            aria-label="Resize AI panel"
            className={[
              "relative shrink-0 bg-border/80 transition-colors",
              showAiPanel
                ? "w-1.5 cursor-col-resize hover:bg-accent/80"
                : "pointer-events-none w-0 opacity-0",
            ].join(" ")}
            onMouseDown={() => setIsAiPanelResizing(true)}
          />

          <div
            className={[
              "min-h-0 shrink-0 overflow-hidden border-l border-border/80 bg-panel transition-[width,opacity] ease-out",
              isAiPanelResizing ? "duration-0" : "duration-300",
              showAiPanel ? "opacity-100" : "w-0 opacity-0",
            ].join(" ")}
            style={{ width: showAiPanel ? `${aiPanelWidth}px` : "0px" }}
            aria-hidden={!showAiPanel}
          >
            <div className="h-full" style={{ width: `${aiPanelWidth}px` }}>
              {aiPanel}
            </div>
          </div>
        </div>
      </div>

      <SshConfigModal
        open={isSshModalOpen}
        onClose={() => setIsSshModalOpen(false)}
        sshConfigs={sshConfigs}
        sshForm={sshForm}
        setSshForm={setSshForm}
        onSaveSsh={saveSsh}
        onConnectServer={connectServer}
        onDeleteSsh={handleDeleteSsh}
      />

      <ScriptConfigModal
        open={isScriptModalOpen}
        onClose={() => setIsScriptModalOpen(false)}
        scripts={scripts}
        scriptForm={scriptForm}
        setScriptForm={setScriptForm}
        onSaveScript={saveScript}
        onRunScript={runScript}
        onDeleteScript={handleDeleteScript}
      />

      <AiConfigModal
        open={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        aiProfiles={aiProfiles}
        activeAiProfileId={activeAiProfileId}
        aiProfileForm={aiProfileForm}
        setAiProfileForm={setAiProfileForm}
        onSaveAiProfile={saveAiProfile}
        onDeleteAiProfile={deleteAiProfile}
        onSelectAiProfile={selectAiProfile}
      />

      <WallpaperModal
        open={isWallpaperModalOpen}
        onClose={() => setIsWallpaperModalOpen(false)}
        wallpaper={wallpaper}
        onChangeWallpaper={setWallpaper}
      />

      <FileEditorModal
        open={isFileEditorOpen}
        onClose={() => setIsFileEditorOpen(false)}
        filePath={openFilePath}
        fileContent={openFileContent}
        onFileContentChange={handleOpenFileContentChange}
        dirtyFile={dirtyFile}
        theme={theme}
      />
    </div>
  );
}

export default App;
