import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export const api = {
  listSshConfigs: () => invoke("list_ssh_configs"),
  saveSshConfig: (input) => invoke("save_ssh_config", { input }),
  deleteSshConfig: (id) => invoke("delete_ssh_config", { id }),
  trustSshHostKey: (input) => invoke("trust_ssh_host_key", { input }),

  listShellSessions: () => invoke("list_shell_sessions"),
  openShellSession: (configId, requestId = null) =>
    invoke("open_shell_session", { input: { configId, requestId } }),
  cancelOpenShellSession: (requestId) =>
    invoke("cancel_open_shell_session", { input: { requestId } }),
  closeShellSession: (sessionId) =>
    invoke("close_shell_session", { input: { sessionId } }),
  ptyWriteInput: (sessionId, data) =>
    invoke("pty_write_input", { input: { sessionId, data } }),
  ptyResize: (sessionId, cols, rows) =>
    invoke("pty_resize", { input: { sessionId, cols, rows } }),
  executeShellCommand: (sessionId, command) =>
    invoke("execute_shell_command", { input: { sessionId, command } }),

  sftpListDir: (sessionId, path) =>
    invoke("sftp_list_dir", { input: { sessionId, path } }),
  sftpReadFile: (sessionId, path) =>
    invoke("sftp_read_file", { input: { sessionId, path } }),
  sftpWriteFile: (sessionId, path, content) =>
    invoke("sftp_write_file", { input: { sessionId, path, content } }),
  sftpCreateFile: (sessionId, path) =>
    invoke("sftp_create_file", { input: { sessionId, path } }),
  sftpCreateDirectory: (sessionId, path) =>
    invoke("sftp_create_directory", { input: { sessionId, path } }),
  sftpDeleteEntry: (sessionId, path, entryType) =>
    invoke("sftp_delete_entry", { input: { sessionId, path, entryType } }),
  sftpRenameEntry: (sessionId, path, newName) =>
    invoke("sftp_rename_entry", { input: { sessionId, path, newName } }),
  sftpUploadFile: (sessionId, remotePath, contentBase64) =>
    invoke("sftp_upload_file", {
      input: { sessionId, remotePath, contentBase64 },
    }),
  sftpUploadFileWithProgress: (
    sessionId,
    remotePath,
    contentBase64,
    transferId,
    localName = null,
  ) =>
    invoke("sftp_upload_file_with_progress", {
      input: { sessionId, remotePath, contentBase64, transferId, localName },
    }),
  sftpSelectUploadFile: () =>
    open({
      multiple: false,
      directory: false,
    }),
  // OS folder picker for the local download target. Typing the path by hand was
  // the only option before, and a wrong one only surfaced when a transfer failed.
  sftpSelectDownloadDir: (defaultPath) =>
    open({
      multiple: false,
      directory: true,
      defaultPath: defaultPath?.trim() ? defaultPath : undefined,
    }),
  sftpUploadLocalFileWithProgress: (
    sessionId,
    remotePath,
    localPath,
    transferId,
    localName = null,
  ) =>
    invoke("sftp_upload_local_file_with_progress", {
      input: { sessionId, remotePath, localPath, transferId, localName },
    }),
  sftpDownloadFile: (sessionId, remotePath) =>
    invoke("sftp_download_file", { input: { sessionId, remotePath } }),
  sftpDownloadFileToLocal: (sessionId, remotePath, localDir, transferId) =>
    invoke("sftp_download_file_to_local", {
      input: { sessionId, remotePath, localDir, transferId },
    }),
  sftpDefaultDownloadDir: () => invoke("sftp_default_download_dir"),
  sftpCancelTransfer: (transferId) =>
    invoke("sftp_cancel_transfer", { input: { transferId } }),
  sshKiRespond: (requestId, responses) =>
    invoke("ssh_ki_respond", { input: { requestId, responses } }),

  fetchServerStatus: (sessionId, selectedInterface) =>
    invoke("fetch_server_status", {
      input: { sessionId, selectedInterface },
    }),
  getCachedServerStatus: (sessionId) =>
    invoke("get_cached_server_status", { sessionId }),

  listScripts: () => invoke("list_scripts"),
  saveScript: (input) => invoke("save_script", { input }),
  deleteScript: (id) => invoke("delete_script", { id }),
  runScript: (sessionId, scriptId) =>
    invoke("run_script", { input: { sessionId, scriptId } }),

  getAgentContext: (serverId = null) =>
    invoke("get_agent_context", { input: { serverId } }),
  saveAgentContext: (serverId = null, content = "") =>
    invoke("save_agent_context", { input: { serverId, content } }),
  deleteAgentContext: (serverId) =>
    invoke("delete_agent_context", { input: { serverId } }),
  listAgentContextFiles: () => invoke("list_agent_context_files"),

  acpAgentList: () => invoke("acp_agent_list"),
  acpAgentStart: (agentId, resumeSessionId = null) =>
    invoke("acp_agent_start", { input: { agentId, resumeSessionId } }),
  acpAgentStop: (agentId) => invoke("acp_agent_stop", { input: { agentId } }),
  acpAgentAuthenticate: (agentId, methodId) =>
    invoke("acp_agent_authenticate", { input: { agentId, methodId } }),
  acpSessionPrompt: (agentId, sessionId, text, images = []) =>
    invoke("acp_session_prompt", { input: { agentId, sessionId, text, images } }),
  acpSessionCancel: (agentId, sessionId) =>
    invoke("acp_session_cancel", { input: { agentId, sessionId } }),
  acpPermissionRespond: (agentId, requestId, optionId = null) =>
    invoke("acp_permission_respond", { input: { agentId, requestId, optionId } }),
  acpSessionSetMode: (agentId, sessionId, modeId) =>
    invoke("acp_session_set_mode", { input: { agentId, sessionId, modeId } }),
  // `value` is a select value id (string) or a boolean, matching the option's
  // type; resolves with the agent's full updated option set.
  acpSessionSetConfigOption: (agentId, sessionId, configId, value) =>
    invoke("acp_session_set_config_option", {
      input: { agentId, sessionId, configId, value },
    }),
  acpHistoryList: () => invoke("acp_history_list"),
  acpHistorySave: (record) => invoke("acp_history_save", { input: { record } }),
  acpHistoryGet: (id) => invoke("acp_history_get", { input: { id } }),
  acpHistoryDelete: (id) => invoke("acp_history_delete", { input: { id } }),
  appVersion: () => invoke("app_version"),
  checkAppUpdate: () => invoke("check_app_update"),

  // Signature-verified in-app update via tauri-plugin-updater. The endpoint is
  // the latest.json the release CI publishes next to the signed installers.
  // `check` throws while the pubkey is still the placeholder (or on old
  // installers built before the plugin existed), so callers treat a rejection
  // here as "in-app update unavailable" and fall back to the GitHub lookup.
  updaterCheck: () => check({ timeout: 15000 }),
  // `update` is the Update instance previously resolved from updaterCheck.
  updaterDownloadAndInstall: async (update, onProgress) => {
    await update.downloadAndInstall((event) => {
      if (!onProgress) {
        return;
      }
      if (event.event === "Started") {
        onProgress({ started: true, contentLength: event.data.contentLength ?? null });
      } else if (event.event === "Progress") {
        onProgress({ downloaded: event.data.chunkLength });
      } else if (event.event === "Finished") {
        onProgress({ finished: true });
      }
    });
  },
  relaunchApp: () => relaunch(),
};
