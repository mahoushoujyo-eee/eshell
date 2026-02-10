import SplitPane from "./components/SplitPane";
import TopToolbar from "./components/layout/TopToolbar";
import AiAssistantPanel from "./components/panels/AiAssistantPanel";
import SftpPanel from "./components/panels/SftpPanel";
import StatusPanel from "./components/panels/StatusPanel";
import TerminalPanel from "./components/panels/TerminalPanel";
import LeftSidebar from "./components/sidebar/LeftSidebar";
import { WALLPAPERS } from "./constants/workbench";
import { useWorkbench } from "./hooks/useWorkbench";

function App() {
  const {
    theme,
    setTheme,
    wallpaper,
    setWallpaper,
    isLeftDrawerOpen,
    setIsLeftDrawerOpen,
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
    currentLogs,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    openFilePath,
    dirtyFile,
    openFileContent,
    aiConfig,
    setAiConfig,
    aiQuestion,
    setAiQuestion,
    aiIncludeOutput,
    setAiIncludeOutput,
    aiAnswer,
    saveSsh,
    connectServer,
    closeSession,
    execCommand,
    uploadFile,
    downloadFile,
    saveScript,
    runScript,
    saveAi,
    askAi,
    refreshSftp,
    openEntry,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    segments,
    formatBytes,
  } = useWorkbench();

  const sftpPanel = (
    <SftpPanel
      activeSessionId={activeSessionId}
      currentPath={currentPath}
      refreshSftp={refreshSftp}
      uploadFile={uploadFile}
      downloadFile={downloadFile}
      selectedEntry={selectedEntry}
      segments={segments}
      sftpEntries={sftpEntries}
      openEntry={openEntry}
      openFilePath={openFilePath}
      dirtyFile={dirtyFile}
      openFileContent={openFileContent}
      onOpenFileContentChange={handleOpenFileContentChange}
      formatBytes={formatBytes}
    />
  );

  const statusPanel = (
    <StatusPanel
      currentStatus={currentStatus}
      currentNic={currentNic}
      onNicChange={handleNicChange}
      formatBytes={formatBytes}
    />
  );

  const aiPanel = (
    <AiAssistantPanel
      aiAnswer={aiAnswer}
      onWriteSuggestedCommand={() => setCommandInput(aiAnswer?.suggestedCommand || "")}
      aiQuestion={aiQuestion}
      setAiQuestion={setAiQuestion}
      aiIncludeOutput={aiIncludeOutput}
      setAiIncludeOutput={setAiIncludeOutput}
      onAskAi={askAi}
    />
  );

  let rightPanelsContent = null;
  if (showStatusPanel && showAiPanel) {
    rightPanelsContent = (
      <SplitPane
        direction="vertical"
        initialRatio={0.36}
        minPrimarySize={160}
        minSecondarySize={300}
        primary={statusPanel}
        secondary={aiPanel}
      />
    );
  } else if (showStatusPanel) {
    rightPanelsContent = statusPanel;
  } else if (showAiPanel) {
    rightPanelsContent = aiPanel;
  }

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
  } else {
    bottomPanelsContent = (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/80 bg-panel/70 p-3 text-xs text-muted">
        已隐藏全部面板，请在顶部工具栏开启 SFTP / 状态 / AI 面板。
      </div>
    );
  }

  return (
    <div className="h-full w-full p-3 text-text lg:p-4">
      <div className="flex h-full flex-col gap-3">
        <TopToolbar
          theme={theme}
          wallpaper={wallpaper}
          isLeftDrawerOpen={isLeftDrawerOpen}
          showSftpPanel={showSftpPanel}
          showStatusPanel={showStatusPanel}
          showAiPanel={showAiPanel}
          onToggleSftpPanel={() => setShowSftpPanel((prev) => !prev)}
          onToggleStatusPanel={() => setShowStatusPanel((prev) => !prev)}
          onToggleAiPanel={() => setShowAiPanel((prev) => !prev)}
          onToggleLeftDrawer={() => setIsLeftDrawerOpen((prev) => !prev)}
          onNextWallpaper={() => setWallpaper((prev) => (prev + 1) % WALLPAPERS.length)}
          onToggleTheme={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
        />

        <div className="panel-card relative min-h-0 flex-1 overflow-hidden">
          {!isLeftDrawerOpen && (
            <button
              type="button"
              className="absolute top-1/2 left-0 z-20 -translate-y-1/2 rounded-r-md border border-border bg-surface px-1.5 py-3 text-xs text-muted shadow"
              onClick={() => setIsLeftDrawerOpen(true)}
              title="展开左侧抽屉"
            >
              {">"}
            </button>
          )}
          <SplitPane
            direction="horizontal"
            initialRatio={0.28}
            minPrimarySize={320}
            minSecondarySize={640}
            collapsed={!isLeftDrawerOpen}
            collapsedPrimarySize={0}
            primary={
              <LeftSidebar
                isOpen={isLeftDrawerOpen}
                onCollapse={() => setIsLeftDrawerOpen(false)}
                sshConfigs={sshConfigs}
                sshForm={sshForm}
                setSshForm={setSshForm}
                onSaveSsh={saveSsh}
                onConnectServer={connectServer}
                onDeleteSsh={handleDeleteSsh}
                scripts={scripts}
                scriptForm={scriptForm}
                setScriptForm={setScriptForm}
                onSaveScript={saveScript}
                onRunScript={runScript}
                onDeleteScript={handleDeleteScript}
                aiConfig={aiConfig}
                setAiConfig={setAiConfig}
                onSaveAi={saveAi}
              />
            }
            secondary={
              <SplitPane
                direction="vertical"
                initialRatio={0.5}
                minPrimarySize={290}
                minSecondarySize={280}
                primary={
                  <TerminalPanel
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    onSelectSession={setActiveSessionId}
                    onCloseSession={closeSession}
                    activeSession={activeSession}
                    commandInput={commandInput}
                    setCommandInput={setCommandInput}
                    onExecCommand={execCommand}
                    currentLogs={currentLogs}
                    wallpaper={wallpaper}
                    wallpapers={WALLPAPERS}
                  />
                }
                secondary={
                  <section className="h-full p-3 pt-0">{bottomPanelsContent}</section>
                }
              />
            }
          />
        </div>

        <footer className="panel-card flex items-center justify-between px-4 py-2 text-xs">
          <div className="text-muted">{busy ? `进行中: ${busy}` : "就绪"}</div>
          <div className="max-w-[60%] truncate text-right text-danger">{error}</div>
        </footer>
      </div>
    </div>
  );
}

export default App;
