import { useStatusEffects } from "./effects";
import { useStatusOperations } from "./operations";
import { useStatusState } from "./state";
import StatusPanel from "./StatusPanel";

// Panel id `status` matches `contributes.panels[0].id` in the shared manifest
// (`extensions/builtin.json`); order 20 puts status second in the bottom dock.
export const STATUS_PANEL_ID = "status";
export const STATUS_EXTENSION_ID = "eshell.server-monitor";

/**
 * The server-monitor plugin controller.
 *
 * It owns the status snapshots, the per-session NIC selection, the refresh
 * interval and the in-flight request tokens; `statusEnabled` on the context
 * is the extension enabled flag. Polling stops when the extension is
 * explicitly disabled, and the interval effect keeps the original
 * "SFTP or status panel visible" condition unchanged.
 *
 * The plugin's API object arrives as `ctx.api` (from `getPlugin(id).api`);
 * the serial-poll/batch/20s improvements in the effects are untouched.
 */
export function useStatusController(ctx) {
  const state = useStatusState();
  const currentStatus = ctx.activeSessionId
    ? state.statusBySession[ctx.activeSessionId]
    : null;
  const currentNic = ctx.activeSessionId
    ? state.nicBySession[ctx.activeSessionId] || null
    : null;

  const operations = useStatusOperations({
    ...ctx,
    ...state,
    currentNic,
  });
  useStatusEffects(
    {
      ...ctx,
      ...state,
      currentNic,
    },
    operations,
  );

  return {
    ...state,
    ...operations,
    currentStatus,
    currentNic,
  };
}

export function createStatusPlugin(api) {
  return {
    id: STATUS_EXTENSION_ID,
    api,
    createController: useStatusController,
    panels: () => [
      {
        id: STATUS_PANEL_ID,
        order: 20,
        key: "status",
        render: (props) => <StatusPanel {...props} />,
      },
    ],
    toolbar: () => [
      {
        id: STATUS_PANEL_ID,
        order: 20,
        key: "status",
        panelId: STATUS_PANEL_ID,
      },
    ],
  };
}
