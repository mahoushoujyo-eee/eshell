// The header: what the host has, and the tab bar.
//
// The status line is the first thing a user needs to check — whether the
// panel found xray, which config it is looking at, and whether the service is
// actually running. Each piece is a dot and a word, so a broken host is
// readable at a glance.

export function createHeader(ctx) {
  const { h, ui, t } = ctx;
  const { Button, Dot, Mono, Pill, Tabs, Toolbar } = ui;

  const serviceTone = (state) => {
    if (!state) {
      return "neutral";
    }
    if (state.active === "active") {
      return "success";
    }
    if (state.active === "failed") {
      return "danger";
    }
    if (state.active === "activating" || state.active === "deactivating") {
      return "warning";
    }
    return "neutral";
  };

  return function Header({ c }) {
    const service = c.service;
    const tabs = [
      { id: "overview", label: t("Overview") },
      { id: "groups", label: t("Groups"), count: c.groups.length },
      { id: "subscriptions", label: t("Subscriptions"), count: c.subscriptions.length },
      { id: "nodes", label: t("Nodes"), count: c.activeNodes.length },
    ];

    return h(
      "div",
      { className: "shrink-0 border-b border-border" },
      h(
        Toolbar,
        { className: "border-b-0" },
        h(
          "div",
          { className: "flex min-w-0 flex-1 items-center gap-2" },
          h(Dot, {
            tone: c.info ? (c.info.bin ? "success" : "danger") : "neutral",
            title: c.info ? (c.info.bin ? c.info.bin : t("xray was not found")) : "",
          }),
          h(
            "span",
            { className: "shrink-0 text-[11px] font-medium text-text" },
            c.info && c.info.bin ? "xray" : t("xray"),
          ),
          c.version
            ? h(Pill, { tone: "neutral" }, `v${c.version}`)
            : null,
          c.effective.configPath
            ? h(
                Mono,
                {
                  className: "min-w-0 truncate text-muted",
                  title: c.effective.configPath,
                },
                c.effective.configPath,
              )
            : h(
                "span",
                { className: "text-[11px] text-muted" },
                c.hasSession ? t("no config found") : t("no session"),
              ),
          h(Dot, {
            tone: serviceTone(service),
            title: service ? `${t("service")}: ${service.active}` : "",
          }),
          h(
            "span",
            { className: "shrink-0 text-[11px] text-muted" },
            service ? service.active : t("unknown"),
          ),
        ),
        h(Button, {
          label: t("Refresh"),
          size: "xs",
          busy: c.loading,
          onClick: c.refresh,
          title: t("Re-read the host and the config"),
        }),
        h(Button, {
          label: t("Settings…"),
          size: "xs",
          onClick: c.openSettings,
          title: t("Binary, config path, service and privilege"),
        }),
      ),
      h(
        "div",
        { className: "flex min-w-0 items-center gap-2 border-t border-border px-3 py-1" },
        h(Tabs, { items: tabs, value: c.tab, onChange: c.setTab }),
      ),
    );
  };
}
