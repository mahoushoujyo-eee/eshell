import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

  getAiConfig: () => invoke("get_ai_config"),
  saveAiConfig: (input) => invoke("save_ai_config", { input }),
  listAiProfiles: () => invoke("list_ai_profiles"),
  saveAiProfile: (input) => invoke("save_ai_profile", { input }),
  deleteAiProfile: (id) => invoke("delete_ai_profile", { id }),
  saveAiApprovalMode: (approvalMode) =>
    invoke("save_ai_approval_mode", { input: { approvalMode } }),
  saveAiAgentMode: (agentMode) =>
    invoke("save_ai_agent_mode", { input: { agentMode } }),
  getAgentContext: (serverId = null) =>
    invoke("get_agent_context", { input: { serverId } }),
  saveAgentContext: (serverId = null, content = "") =>
    invoke("save_agent_context", { input: { serverId, content } }),
  setActiveAiProfile: (id) =>
    invoke("set_active_ai_profile", { input: { id } }),
  askAi: (input) => invoke("ai_ask", { input }),

  opsAgentListConversations: () => invoke("ops_agent_list_conversations"),
  opsAgentCreateConversation: (title, sessionId = null) =>
    invoke("ops_agent_create_conversation", { input: { title, sessionId } }),
  opsAgentGetConversation: (conversationId) =>
    invoke("ops_agent_get_conversation", { input: { conversationId } }),
  opsAgentGetAttachmentContent: (attachmentId) =>
    invoke("ops_agent_get_attachment_content", { input: { attachmentId } }),
  opsAgentDeleteConversation: (conversationId) =>
    invoke("ops_agent_delete_conversation", { input: { conversationId } }),
  opsAgentSetActiveConversation: (conversationId) =>
    invoke("ops_agent_set_active_conversation", { input: { conversationId } }),
  opsAgentCompactConversation: (conversationId) =>
    invoke("ops_agent_compact_conversation", { input: { conversationId } }),
  opsAgentChatStreamStart: (input) =>
    invoke("ops_agent_chat_stream_start", { input }),
  opsAgentListPendingActions: (sessionId = null, onlyPending = true) =>
    invoke("ops_agent_list_pending_actions", { input: { sessionId, onlyPending } }),
  opsAgentResolveAction: (actionId, approve, sessionId = null, comment = null) =>
    invoke("ops_agent_resolve_action", { input: { actionId, approve, sessionId, comment } }),
  opsAgentCancelRun: (runId) =>
    invoke("ops_agent_cancel_run", { input: { runId } }),

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

  listAiImportSources: (customPaths = []) =>
    invoke("list_ai_import_sources", { input: { customPaths } }),
  detectAiImportCandidates: (source) =>
    invoke("detect_ai_import_candidates", { input: { source } }),
  importAiProfiles: (candidates) =>
    invoke("import_ai_profiles", { input: { candidates } }),
  aiImportSourceKindLabel: (kind) =>
    invoke("ai_import_source_kind_label", { kind }),
};
