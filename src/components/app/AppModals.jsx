import AgentConfigModal from "../sidebar/AgentConfigModal";
import ScriptConfigModal from "../sidebar/ScriptConfigModal";
import SshConfigModal from "../sidebar/SshConfigModal";
import WallpaperModal from "../sidebar/WallpaperModal";
import SshHostTrustDialog from "./SshHostTrustDialog";
import SshKiPromptDialog from "./SshKiPromptDialog";

export default function AppModals({
  workbench,
  modalState,
}) {
  const {
    sshConfigs,
    sshForm,
    setSshForm,
    saveSsh,
    connectServer,
    cancelConnectServer,
    handleDeleteSsh,
    scripts,
    scriptForm,
    setScriptForm,
    saveScript,
    runScript,
    handleDeleteScript,
    pushUiNotice,
    wallpaper,
    setWallpaper,
    hostKeyTrustPrompt,
    resolveHostKeyTrust,
    kiPrompt,
    dismissKiPrompt,
  } = workbench;
  const {
    isSshModalOpen,
    onCloseSshModal,
    isScriptModalOpen,
    onCloseScriptModal,
    isAgentConfigOpen,
    onCloseAgentConfig,
    isWallpaperModalOpen,
    onCloseWallpaperModal,
  } = modalState;

  return (
    <>
      <SshConfigModal
        open={isSshModalOpen}
        onClose={onCloseSshModal}
        sshConfigs={sshConfigs}
        sshForm={sshForm}
        setSshForm={setSshForm}
        onSaveSsh={saveSsh}
        onConnectServer={connectServer}
        onCancelConnectServer={cancelConnectServer}
        onDeleteSsh={handleDeleteSsh}
      />

      <ScriptConfigModal
        open={isScriptModalOpen}
        onClose={onCloseScriptModal}
        scripts={scripts}
        scriptForm={scriptForm}
        setScriptForm={setScriptForm}
        onSaveScript={saveScript}
        onRunScript={runScript}
        onDeleteScript={handleDeleteScript}
      />

      <AgentConfigModal
        open={isAgentConfigOpen}
        onClose={onCloseAgentConfig}
        sshConfigs={sshConfigs}
        onNotice={pushUiNotice}
      />

      <WallpaperModal
        open={isWallpaperModalOpen}
        onClose={onCloseWallpaperModal}
        wallpaper={wallpaper}
        onChangeWallpaper={setWallpaper}
      />

      <SshHostTrustDialog
        challenge={hostKeyTrustPrompt}
        onResolve={resolveHostKeyTrust}
      />

      <SshKiPromptDialog
        prompt={kiPrompt}
        onDismiss={dismissKiPrompt}
      />
    </>
  );
}
