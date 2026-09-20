import { useMemo } from "react";
import { normalizeRemotePath } from "../../utils/path";
import { useSftpEffects } from "./effects";
import { useSftpOperations } from "./operations";
import { useSftpState } from "./state";
import SftpPanel from "./SftpPanel";

// Panel id `sftp` matches `contributes.panels[0].id` in the shared manifest
// (`extensions/builtin.json`); order 10 puts SFTP first in the bottom dock.
export const SFTP_PANEL_ID = "sftp";
export const SFTP_EXTENSION_ID = "eshell.sftp";

/**
 * The sftp plugin controller.
 *
 * It owns its state outright (paths, entries, selection, transfers, the open
 * file editor, the download directory, the debounced-save timer): the
 * workbench hands it only the shared session context (sessions, selected id,
 * reconnect/busy plumbing) plus the plugin's API object (`ctx.api`, from
 * `getPlugin(id).api`), and receives the panel's public surface back.
 *
 * `currentPath` is derived here from the active session plus the plugin's own
 * path tracking, exactly as the pre-plugin hook derived it.
 */
export function useSftpController(ctx) {
  // Plugin-owned state. Defaults and localStorage keys are unchanged.
  const state = useSftpState();

  const activeSession = useMemo(
    () => ctx.sessions.find((item) => item.id === ctx.activeSessionId) || null,
    [ctx.sessions, ctx.activeSessionId],
  );

  // `currentPath`, moved verbatim from useWorkbench: the active session's
  // tracked path or its login directory, normalized.
  const currentPath = useMemo(
    () =>
      normalizeRemotePath(
        activeSession
          ? state.sftpPath[activeSession.id] || activeSession.currentDir || "/"
          : "/",
      ),
    [activeSession, state.sftpPath],
  );

  const operations = useSftpOperations({
    ...ctx,
    ...state,
    activeSession,
    currentPath,
  });
  useSftpEffects(
    {
      ...ctx,
      ...state,
      activeSession,
      currentPath,
    },
    operations,
  );

  return {
    ...state,
    ...operations,
    activeSession,
    currentPath,
  };
}

export function createSftpPlugin(api) {
  return {
    id: SFTP_EXTENSION_ID,
    api,
    createController: useSftpController,
    panels: () => [
      {
        id: SFTP_PANEL_ID,
        order: 10,
        key: "sftp",
        // Render props are forwarded verbatim (the workbench supplies the
        // session context and this plugin's `api` through them); the closure
        // only fixes which component renders.
        render: (props) => <SftpPanel {...props} />,
      },
    ],
    toolbar: () => [
      {
        id: SFTP_PANEL_ID,
        order: 10,
        key: "sftp",
        panelId: SFTP_PANEL_ID,
      },
    ],
  };
}
