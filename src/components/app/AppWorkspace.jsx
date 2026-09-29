import { lazy, Suspense, useEffect } from "react";
import StatusBar from "../layout/StatusBar";
import TopToolbar from "../layout/TopToolbar";
import UiNoticeStack from "../layout/UiNoticeStack";
import WindowTitleBar from "../layout/WindowTitleBar";
import { loadFileEditorModal, preloadFileEditorModal } from "../panels/file-editor-loader";
import AppAiDock from "./AppAiDock";
import AppMainWorkspace from "./AppMainWorkspace";

// Kept out of the startup graph: the editor's markdown/Prism stack is heavy and
// only matters once a file is opened. See `file-editor-loader.js`.
const FileEditorModal = lazy(loadFileEditorModal);

export default function AppWorkspace({
  workbench,
  acp,
  ui,
}) {
  const {
    theme,
    showSftpPanel,
    setShowSftpPanel,
    showStatusPanel,
    setShowStatusPanel,
    showCommandDraftPanel,
    setShowCommandDraftPanel,
    showAiPanel,
    setShowAiPanel,
    busy,
    error,
    uiNotices,
    dismissUiNotice,
    openFilePath,
    dirtyFile,
    openFileContent,
    handleOpenFileContentChange,
    fileAutoSync,
    saveOpenFile,
    resetFileEditor,
    extensions,
    sessions,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    closeSession,
    disconnectedSessions,
    sshConfigs,
  } = workbench;
  const {
    sidebarCollapsed,
    onToggleSidebarCollapsed,
    onOpenSshConfig,
    onOpenScriptConfig,
    onOpenWallpaperPicker,
    onOpenAgentConfig,
    onOpenSettings,
    workspaceRef,
    aiPanelWidth,
    isAiPanelResizing,
    onStartAiPanelResize,
    isFileEditorOpen,
    onOpenFileEditor,
    onCloseFileEditor,
  } = ui;

  // Warm the editor chunk once the first screen is up and the app is idle.
  useEffect(() => preloadFileEditorModal(), []);

  return (
    <>
      <WindowTitleBar
        showAiPanel={showAiPanel}
        onToggleAiPanel={() => setShowAiPanel((current) => !current)}
        isAiStreaming={acp.turnActive}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onCloseSession={closeSession}
        disconnectedSessions={disconnectedSessions}
        onNewSession={onOpenSshConfig}
      />
      <UiNoticeStack notices={uiNotices} onDismiss={dismissUiNotice} />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-panel">
        <TopToolbar
          showSftpPanel={showSftpPanel}
          showStatusPanel={showStatusPanel}
          showCommandDraftPanel={showCommandDraftPanel}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={onToggleSidebarCollapsed}
          onOpenSshConfig={onOpenSshConfig}
          onOpenScriptConfig={onOpenScriptConfig}
          onOpenAgentConfig={onOpenAgentConfig}
          onOpenSettings={onOpenSettings}
          onToggleSftpPanel={() => setShowSftpPanel((prev) => !prev)}
          onToggleStatusPanel={() => setShowStatusPanel((prev) => !prev)}
          onToggleCommandDraftPanel={() => setShowCommandDraftPanel((prev) => !prev)}
          extensions={extensions}
          workbench={workbench}
        />

        <div ref={workspaceRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <AppMainWorkspace
              workbench={workbench}
              acp={acp}
              showSftpPanel={showSftpPanel}
              showStatusPanel={showStatusPanel}
              showCommandDraftPanel={showCommandDraftPanel}
              onOpenFileEditor={onOpenFileEditor}
              onOpenSshConfig={onOpenSshConfig}
            />
          </div>

          {/* External plugin controller hosts: one keyed sibling per external
              plugin. Enabling a plugin appends one; disabling removes exactly
              that one — the core layout (and the terminal's component chain)
              never changes, so it cannot remount. */}
          {workbench.pluginControllerHosts}

          <AppAiDock
            acp={acp}
            showAiPanel={showAiPanel}
            aiPanelWidth={aiPanelWidth}
            isAiPanelResizing={isAiPanelResizing}
            onStartAiPanelResize={onStartAiPanelResize}
          />
        </div>
      </div>

      <StatusBar
        activeSession={activeSession}
        sshConfigs={sshConfigs}
        disconnectedSessions={disconnectedSessions}
        busy={busy}
        error={error}
        isAiStreaming={acp.turnActive}
      />

      {/* Mounted only while open: the modal renders nothing when closed and
          resets its own state on open, so unmounting it loses nothing — and
          it keeps the lazy chunk from being requested until it is needed. */}
      {isFileEditorOpen ? (
        <Suspense fallback={null}>
          <FileEditorModal
            open={isFileEditorOpen}
            onClose={onCloseFileEditor}
            filePath={openFilePath}
            fileContent={openFileContent}
            onFileContentChange={handleOpenFileContentChange}
            dirtyFile={dirtyFile}
            autoSync={fileAutoSync}
            onSave={saveOpenFile}
            onDiscard={resetFileEditor}
            theme={theme}
          />
        </Suspense>
      ) : null}
    </>
  );
}
