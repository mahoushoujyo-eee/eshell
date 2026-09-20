import { describeApi, title } from "./message.js";

export async function activate(eshell) {
  const { createElement: h, useState } = eshell.react;
  const activations = Number(eshell.storage.get("activations") || 0) + 1;
  eshell.storage.set("activations", activations);
  const sessions = await eshell.sessions.list();

  const disposeController = eshell.ui.registerController(function useHelloController() {
    const [clicks, setClicks] = useState(() => Number(eshell.storage.get("clicks") || 0));
    const increment = () => {
      const next = clicks + 1;
      eshell.storage.set("clicks", next);
      setClicks(next);
    };
    return { clicks, increment };
  });

  const disposePanel = eshell.ui.registerPanel({
    id: "com.example.hello.panel",
    key: "com.example.hello.panel",
    title,
    order: 30,
    // Panels start hidden unless they ask to be shown. This example asks, so
    // the panel is visible right after install; drop the line to start hidden
    // and let the toolbar button open it.
    defaultVisible: true,
    render: ({ context, controller }) => h(
      "section",
      { className: "flex h-full min-h-0 flex-col gap-3 bg-panel p-4", "aria-label": title },
      h("h2", { className: "text-sm font-semibold" }, title),
      h("p", { className: "text-xs" }, describeApi(eshell.meta.apiVersion)),
      h("p", { className: "text-xs" }, `Sessions at activation: ${sessions.length}`),
      h("p", { className: "text-xs" }, `Current session: ${context.activeSessionId || "none"}`),
      h("p", { className: "text-xs", "data-testid": "hello-activations" }, `Activations: ${activations}`),
      h("button", {
        type: "button",
        className: "rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent-soft",
        "data-testid": "hello-counter",
        onClick: controller.increment,
      }, `Clicks: ${controller.clicks}`),
    ),
  });

  const disposeToolbar = eshell.ui.registerToolbar({
    id: "com.example.hello.toolbar",
    key: "com.example.hello.toolbar",
    panelId: "com.example.hello.panel",
    label: title,
    icon: "puzzle",
    order: 30,
  });

  eshell.log.info("activated", { activations });
  return () => {
    disposeToolbar();
    disposePanel();
    disposeController();
    eshell.log.info("deactivated");
  };
}
