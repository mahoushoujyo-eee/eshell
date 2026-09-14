import AgentConfigModal from "../sidebar/AgentConfigModal";
import ScriptConfigModal from "../sidebar/ScriptConfigModal";
import SettingsModal from "../sidebar/SettingsModal";
import SshConfigModal from "../sidebar/SshConfigModal";
import WallpaperModal from "../sidebar/WallpaperModal";
import SshHostTrustDialog from "./SshHostTrustDialog";
import SshKiPromptDialog from "./SshKiPromptDialog";
import { getWallpaperLabel } from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";

export default function AppModals({
  workbench,
  modalState,
}) {
  const { t } = useI18n();
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
    theme,
    setTheme,
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
    isSettingsOpen,
    onCloseSettings,
    onOpenWallpaperPicker,
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

      <SettingsModal
        open={isSettingsOpen}
        onClose={onCloseSettings}
        theme={theme}
        onSelectTheme={setTheme}
        wallpaperLabel={t(getWallpaperLabel(wallpaper))}
        onOpenWallpaperPicker={onOpenWallpaperPicker}
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
