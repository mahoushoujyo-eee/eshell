import { useForwardEffects } from "./effects";
import { useForwardOperations } from "./operations";
import { selectSessionForwards, useForwardState } from "./state";
import ForwardPanel from "./ForwardPanel";

// Panel id `forward` matches `contributes.panels[0].id` in the shared manifest
// (`extensions/builtin.json`); order 30 puts it last in the bottom dock.
export const FORWARD_PANEL_ID = "forward";
export const FORWARD_EXTENSION_ID = "eshell.forward";

/**
 * The port-forward plugin controller.
 *
 * It owns its state outright (the row cache, the dialog flags, the in-flight
 * stop) and receives the shared session context plus its API object from the
 * workbench. Forwards are keyed by shell tab: the panel always shows the
 * active tab's forwards, and the backend stops them when that tab closes.
 */
export function useForwardController(ctx) {
  const state = useForwardState();

  const operations = useForwardOperations({
    ...ctx,
    ...state,
  });
  useForwardEffects(
    {
      ...ctx,
      ...state,
    },
    operations,
  );

  const sessionForwards = selectSessionForwards(
    state.forwardsBySession,
    ctx.activeSessionId,
  );

  return {
    ...state,
    ...operations,
    sessionForwards,
  };
}

export function createForwardPlugin(api) {
  return {
    id: FORWARD_EXTENSION_ID,
    api,
    createController: useForwardController,
    panels: () => [
      {
        id: FORWARD_PANEL_ID,
        order: 30,
        key: "forward",
        // Render props are forwarded verbatim (the workbench supplies the
        // session context and this plugin's `api` through them); the closure
        // only fixes which component renders.
        render: (props) => <ForwardPanel {...props} />,
      },
    ],
    toolbar: () => [
      {
        id: FORWARD_PANEL_ID,
        order: 30,
        key: "forward",
        panelId: FORWARD_PANEL_ID,
      },
    ],
  };
}
