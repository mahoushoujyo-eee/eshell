import { useEffect, useRef } from "react";
import { normalizeSftpTransferEvent, upsertSftpTransfer } from "../../lib/sftp-transfer";
import { normalizeRemotePath } from "../../utils/path";

const sftpRemoteParentDir = (path) => {
  if (!path || path === "/") return "/";
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = p.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : p.substring(0, lastSlash);
};

/**
 * SFTP effects, moved verbatim from `hooks/workbench/effects.js`.
 *
 * Transfer events are mirrored into the transfer queue regardless of panel
 * visibility (closing the panel never cancels transfers); the post-upload
 * directory refresh only fires while the panel is visible, and only when the
 * upload landed in the directory being browsed.
 *
 * The `sftp-transfer` subscription now comes from the injected plugin API
 * (`ctx.api.sftp.onTransfer`) instead of a direct Tauri event import: the
 * facade unwraps and validates the payload, and the subscription is owned by
 * the activation scope. The handler semantics are unchanged.
 *
 * Dependency stability: the listener binds once per mount — `refreshSftp` is
 * identity-stable (latest-ref context in operations) and the handler reads
 * the live workbench values through a latest-ref, so an unrelated re-render
 * neither re-binds the listener nor drops in-flight transfer events. The
 * debounced save depends on the scalar editor fields only; a transfer queue
 * update cannot reset a pending 700ms save.
 */
export function useSftpEffects(ctx, sftpOps) {
  // Latest-ref reads for everything the event handler needs at fire time.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const sftpOpsRef = useRef(sftpOps);
  sftpOpsRef.current = sftpOps;

  // sftp-transfer event stream: mirror progress into the queue, refresh the
  // browsed directory after a completed upload into it. Bound once; the
  // handler resolves current values through refs.
  useEffect(() => {
    const current = ctxRef.current;
    const pluginApi = current?.api;
    if (!pluginApi?.sftp?.onTransfer) {
      return undefined;
    }
    // `onTransfer` returns a synchronous idempotent unsubscribe; the
    // activation scope owns the underlying native listener.
    return pluginApi.sftp.onTransfer((normalized) => {
      const live = ctxRef.current;
      live.setSftpTransfers((prev) => upsertSftpTransfer(prev, normalized));

      if (
        normalized.stage === "completed" &&
        normalized.direction === "upload" &&
        normalized.sessionId === live.activeSessionId &&
        live.showSftpPanel &&
        normalized.remotePath
      ) {
        const remoteParent = sftpRemoteParentDir(normalized.remotePath);
        if (
          remoteParent === live.currentPath ||
          normalized.remotePath === live.currentPath
        ) {
          void sftpOpsRef.current.refreshSftp(live.currentPath);
        }
      }
    });
    // Empty deps: bind once per mount. All inputs are read through refs at
    // event time, so no workbench re-render can drop the subscription.
  }, []);

  // Switching tabs drops the previous tab's directory listing and selection;
  // the listing for the tab being switched to is refetched by the workbench.
  // Setters are stable, so this re-runs exactly when the session changes.
  useEffect(() => {
    ctx.setSftpEntries([]);
    ctx.setSelectedEntry(null);
  }, [ctx.activeSessionId, ctx.setSftpEntries, ctx.setSelectedEntry]);

  // The debounced remote save. Targets the session the file was opened from,
  // not the active tab, so switching tabs mid-edit cannot write to the wrong
  // server. Scalar deps only: only an editor change resets the 700ms timer.
  useEffect(() => {
    if (!ctx.openFileSessionId || !ctx.openFilePath || !ctx.dirtyFile) {
      return undefined;
    }
    if (ctx.saveTimerRef.current) {
      clearTimeout(ctx.saveTimerRef.current);
    }
    ctx.saveTimerRef.current = setTimeout(async () => {
      const current = ctxRef.current;
      try {
        await current.runBusy("Save edited file", () =>
          current.runWithSessionReconnect(current.openFileSessionId, (sessionId) =>
            // Save with debounce to avoid writing on each keystroke.
            current.api.sftp.writeFile(
              sessionId,
              current.openFilePath,
              current.openFileContent,
            ),
          ),
        );
        current.setDirtyFile(false);
      } catch (err) {
        current.onError(err);
      }
    }, 700);

    return () => {
      if (ctx.saveTimerRef.current) {
        clearTimeout(ctx.saveTimerRef.current);
      }
    };
    // Editor scalars + stable setters/refs: a transfers update or a poll
    // snapshot cannot starve or reset this timer.
  }, [
    ctx.dirtyFile,
    ctx.openFileContent,
    ctx.openFilePath,
    ctx.openFileSessionId,
    ctx.saveTimerRef,
  ]);
}

export { sftpRemoteParentDir, normalizeRemotePath };
