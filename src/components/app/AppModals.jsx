import AiConfigModal from "../sidebar/AiConfigModal";
import ScriptConfigModal from "../sidebar/ScriptConfigModal";
import SshConfigModal from "../sidebar/SshConfigModal";
import WallpaperModal from "../sidebar/WallpaperModal";

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
    handleDeleteSsh,
    scripts,
    scriptForm,
    setScriptForm,
    saveScript,
    runScript,
    handleDeleteScript,
    aiProfiles,
    activeAiProfileId,
    aiProfileForm,
    setAiProfileForm,
    saveAiProfile,
    deleteAiProfile,
    selectAiProfile,
    wallpaper,
    setWallpaper,
  } = workbench;
  const {
    isSshModalOpen,
    onCloseSshModal,
    isScriptModalOpen,
    onCloseScriptModal,
    isAiModalOpen,
    onCloseAiModal,
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

      <AiConfigModal
        open={isAiModalOpen}
        onClose={onCloseAiModal}
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
        onClose={onCloseWallpaperModal}
        wallpaper={wallpaper}
        onChangeWallpaper={setWallpaper}
      />
    </>
  );
}
