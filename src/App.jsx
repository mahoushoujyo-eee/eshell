import { useState } from "react";
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
import { WALLPAPERS } from "./constants/workbench";
import { useWorkbench } from "./hooks/useWorkbench";

function App() {
  const [isSshModalOpen, setIsSshModalOpen] = useState(false);
  const [isScriptModalOpen, setIsScriptModalOpen] = useState(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [isFileEditorOpen, setIsFileEditorOpen] = useState(false);

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
    currentLogs,
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
    saveAiProfile,
    selectAiProfile,
    deleteAiProfile,
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
      aiProfiles={aiProfiles}
      activeAiProfileId={activeAiProfileId}
      onSelectAiProfile={selectAiProfile}
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
      <div className="flex h-full items-center justify-center border border-dashed border-border/80 bg-panel/70 p-3 text-xs text-muted">
        已隐藏全部面板，请在左侧导航栏开启 SFTP / 状态 / AI 面板。
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden text-text">
      <WindowTitleBar />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-panel">
        <TopToolbar
          theme={theme}
          wallpaper={wallpaper}
          showSftpPanel={showSftpPanel}
          showStatusPanel={showStatusPanel}
          showAiPanel={showAiPanel}
          onOpenSshConfig={() => setIsSshModalOpen(true)}
          onOpenScriptConfig={() => setIsScriptModalOpen(true)}
          onOpenAiConfig={() => setIsAiModalOpen(true)}
          onToggleSftpPanel={() => setShowSftpPanel((prev) => !prev)}
          onToggleStatusPanel={() => setShowStatusPanel((prev) => !prev)}
          onToggleAiPanel={() => setShowAiPanel((prev) => !prev)}
          onNextWallpaper={() => setWallpaper((prev) => (prev + 1) % WALLPAPERS.length)}
          onToggleTheme={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
          busy={busy}
          error={error}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            secondary={<section className="h-full">{bottomPanelsContent}</section>}
          />
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

