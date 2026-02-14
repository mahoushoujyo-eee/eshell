import { invoke } from "@tauri-apps/api/core";

export const api = {
  listSshConfigs: () => invoke("list_ssh_configs"),
  saveSshConfig: (input) => invoke("save_ssh_config", { input }),
  deleteSshConfig: (id) => invoke("delete_ssh_config", { id }),

  listShellSessions: () => invoke("list_shell_sessions"),
  openShellSession: (configId) =>
    invoke("open_shell_session", { input: { configId } }),
  closeShellSession: (sessionId) =>
    invoke("close_shell_session", { input: { sessionId } }),
  executeShellCommand: (sessionId, command) =>
    invoke("execute_shell_command", { input: { sessionId, command } }),

  sftpListDir: (sessionId, path) =>
    invoke("sftp_list_dir", { input: { sessionId, path } }),
  sftpReadFile: (sessionId, path) =>
    invoke("sftp_read_file", { input: { sessionId, path } }),
  sftpWriteFile: (sessionId, path, content) =>
    invoke("sftp_write_file", { input: { sessionId, path, content } }),
  sftpUploadFile: (sessionId, remotePath, contentBase64) =>
    invoke("sftp_upload_file", {
      input: { sessionId, remotePath, contentBase64 },
    }),
  sftpDownloadFile: (sessionId, remotePath) =>
    invoke("sftp_download_file", { input: { sessionId, remotePath } }),

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

  getAiConfig: () => invoke("get_ai_config"),
  saveAiConfig: (input) => invoke("save_ai_config", { input }),
  listAiProfiles: () => invoke("list_ai_profiles"),
  saveAiProfile: (input) => invoke("save_ai_profile", { input }),
  deleteAiProfile: (id) => invoke("delete_ai_profile", { id }),
  setActiveAiProfile: (id) =>
    invoke("set_active_ai_profile", { input: { id } }),
  askAi: (input) => invoke("ai_ask", { input }),
};
