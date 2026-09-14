import TopToolbar from "../layout/TopToolbar";
import UiNoticeStack from "../layout/UiNoticeStack";
import WindowTitleBar from "../layout/WindowTitleBar";
import AppAiDock from "./AppAiDock";
import AppMainWorkspace from "./AppMainWorkspace";
import FileEditorModal from "../panels/FileEditorModal";

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

  return (
    <>
      <WindowTitleBar
        showAiPanel={showAiPanel}
        onToggleAiPanel={() => setShowAiPanel((current) => !current)}
        isAiStreaming={acp.turnActive}
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
          busy={busy}
          error={error}
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
            />
          </div>

          <AppAiDock
            acp={acp}
            showAiPanel={showAiPanel}
            aiPanelWidth={aiPanelWidth}
            isAiPanelResizing={isAiPanelResizing}
            onStartAiPanelResize={onStartAiPanelResize}
            onClose={() => setShowAiPanel(false)}
          />
        </div>
      </div>

      <FileEditorModal
        open={isFileEditorOpen}
        onClose={onCloseFileEditor}
        filePath={openFilePath}
        fileContent={openFileContent}
        onFileContentChange={handleOpenFileContentChange}
        dirtyFile={dirtyFile}
        theme={theme}
      />
    </>
  );
}
