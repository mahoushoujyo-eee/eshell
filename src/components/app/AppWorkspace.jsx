import TopToolbar from "../layout/TopToolbar";
import UiNoticeStack from "../layout/UiNoticeStack";
import WindowTitleBar from "../layout/WindowTitleBar";
import AppAiDock from "./AppAiDock";
import AppMainWorkspace from "./AppMainWorkspace";
import FileEditorModal from "../panels/FileEditorModal";
import { getWallpaperLabel } from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";

export default function AppWorkspace({
  workbench,
  ui,
}) {
  const { t } = useI18n();
  const {
    theme,
    setTheme,
    wallpaper,
    showSftpPanel,
    setShowSftpPanel,
    showStatusPanel,
    setShowStatusPanel,
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
    onOpenAiConfig,
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
        isAiStreaming={workbench.isAiStreaming}
      />
      <UiNoticeStack notices={uiNotices} onDismiss={dismissUiNotice} />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-panel">
        <TopToolbar
          theme={theme}
          wallpaperLabel={t(getWallpaperLabel(wallpaper))}
          showSftpPanel={showSftpPanel}
          showStatusPanel={showStatusPanel}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={onToggleSidebarCollapsed}
          onOpenSshConfig={onOpenSshConfig}
          onOpenScriptConfig={onOpenScriptConfig}
          onOpenWallpaperPicker={onOpenWallpaperPicker}
          onToggleSftpPanel={() => setShowSftpPanel((prev) => !prev)}
          onToggleStatusPanel={() => setShowStatusPanel((prev) => !prev)}
          onToggleTheme={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
          busy={busy}
          error={error}
        />

        <div ref={workspaceRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <AppMainWorkspace
              workbench={workbench}
              showSftpPanel={showSftpPanel}
              showStatusPanel={showStatusPanel}
              onOpenFileEditor={onOpenFileEditor}
            />
          </div>

          <AppAiDock
            workbench={workbench}
            showAiPanel={showAiPanel}
            aiPanelWidth={aiPanelWidth}
            isAiPanelResizing={isAiPanelResizing}
            onStartAiPanelResize={onStartAiPanelResize}
            onOpenAiConfig={onOpenAiConfig}
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
