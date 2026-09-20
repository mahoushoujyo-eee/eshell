// Private bridge between the plugin facade (`src/plugins/api.js`) and the
// native transport (`src/lib/tauri-api.js`).
//
// This is the ONLY place plugin-facing code touches `tauri-api` or
// `@tauri-apps/api/event`. `src/plugins/` production code (the facade, the
// loader, the builtin plugins) imports nothing from `tauri-api` directly: the
// loader injects one bridge per activation scope into
// `createPluginApi(pluginId, { host })`, and the facade closes over it.
// Nothing host-shaped is reachable through the returned plugin API object.
//
// Native surface (append-only on `tauri-api`; existing methods untouched):
//   api.listExternalPlugins()               -> external descriptor rows only
//   api.invokeExtensionApi({ extensionId, command, args })
//     The private broker. Every facade operation — including the native file
//     pickers — routes through it as `{ extensionId, command, args }` with
//     existing Tauri command names and argument shapes, so the backend holds
//     the caller extension's lease across the whole operation.
import { api } from "./tauri-api";
import { listen } from "@tauri-apps/api/event";

// Commands the facade is allowed to broker. `command` is private transport,
// never exposed on the plugin API; names and argument shapes are the existing
// Tauri ones (see `tauri-api.js`), so the backend whitelist matches what the
// app already invokes. Raw PTY input and configuration credential APIs are
// deliberately absent.
const BROKERED_COMMANDS = new Set([
  "list_shell_sessions",
  "open_shell_session",
  "close_shell_session",
  "execute_shell_command",
  "sftp_list_dir",
  "sftp_read_file",
  "sftp_write_file",
  "sftp_create_file",
  "sftp_create_directory",
  "sftp_delete_entry",
  "sftp_rename_entry",
  "sftp_upload_local_file_with_progress",
  "sftp_download_file_to_local",
  "sftp_default_download_dir",
  "sftp_cancel_transfer",
  "fetch_server_status",
  "get_cached_server_status",
  // Read-only config reload: re-reads files the user already wrote and
  // returns per-file outcomes, never credentials.
  "reload_config",
  "list_reloadable_configs",
  // Private broker operations (not standalone Tauri commands). They accept
  // `{ title?, defaultPath? }` and resolve to a path string or null; the
  // backend keeps the picker's caller lease until it resolves.
  "select_upload_file",
  "select_download_dir",
]);

// ---------------------------------------------------------------------------
// Process-wide host-key prompt signal.
//
// There is no native host-key event. The workbench's TOFU prompt path calls
// `emitHostKeyPrompt(challenge)` when it
// presents a challenge; every live activation scope's
// `sessions.onHostKeyPrompt` subscription observes it. The signal never
// aliases `ssh-ki-prompt`, carries no reply channel, and adds no
// trust-write API — open failures still reject normally and the workbench
// still resolves trust itself.
// ---------------------------------------------------------------------------
const hostKeyPromptListeners = new Set();

/**
 * Emits one host-key challenge to every registered `onHostKeyPrompt`
 * subscriber. The challenge object passes through unwrapped (readonly for
 * observers); observers cannot reply.
 */
export function emitHostKeyPrompt(challenge) {
  if (!challenge || typeof challenge !== "object") {
    return;
  }
  const notification = Object.freeze({ ...challenge });
  for (const listener of [...hostKeyPromptListeners]) {
    try {
      listener(notification);
    } catch (error) {
      console.warn("[plugin-host] host-key prompt observer failed", error);
    }
  }
}

const addHostKeyPromptListener = (listener) => {
  hostKeyPromptListeners.add(listener);
  return () => hostKeyPromptListeners.delete(listener);
};

/**
 * Creates the private per-scope host bridge. The loader passes one instance
 * per activation into `createPluginApi(pluginId, { host })`.
 */
export function createPluginHostBridge() {
  return {
    /** External descriptors only (`builtin: false`); the loader fetches
     *  `list_extensions` separately for the merged catalog. */
    listExternalPlugins: () => api.listExternalPlugins(),

    /** The merged builtin + external catalog (the authoritative enabled
     *  state). Same command the workbench's extension state uses. */
    listExtensions: () => api.listExtensions(),
    setExtensionEnabled: (extensionId, enabled) => api.setExtensionEnabled(extensionId, enabled),

    /** Brokers one facade operation. The backend holds the caller
     *  extension's native lease across the operation. */
    invokeExtensionApi: ({ extensionId, command, args }) => {
      if (!BROKERED_COMMANDS.has(command)) {
        return Promise.reject(
          new Error(`plugin host: command is not brokered: ${command}`),
        );
      }
      return api.invokeExtensionApi({ extensionId, command, args });
    },

    /** Native event registration for the facade's wrapped subscriptions.
     *  Resolves with the underlying unlisten function. */
    listenPluginEvent: (name, handler) => listen(name, handler),

    /** In-process host-key prompt subscription (see `emitHostKeyPrompt`).
     *  Returns a synchronous remover. */
    addHostKeyPromptListener,
  };
}
