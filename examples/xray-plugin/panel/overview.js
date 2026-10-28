// The overview: what the host has and what the panel can do with it.
//
// The counts come from the config, not from xray's own status output, so the
// numbers here are the numbers in the file the panel writes — which is the
// point: the panel shows the config it is about to change.

export function createOverview(ctx) {
  const { h, ui, t } = ctx;
  const { Button, KeyValue, StatTile, Toolbar } = ui;

  return function Overview({ c }) {
    const s = c.summary;
    const rows = [
      { label: t("Binary"), value: c.effective.bin || t("not found"), mono: true },
      { label: t("Config"), value: c.effective.configPath || t("not found"), mono: true },
      { label: t("Config directory"), value: c.effective.dir || "—", mono: true },
      { label: t("Service"), value: c.effective.unit || t("none"), mono: true },
      {
        label: t("Service state"),
        value: c.service ? `${c.service.active} · ${c.service.enabled}` : t("unknown"),
      },
      {
        label: t("Writable"),
        value: c.effective.writable
          ? t("yes")
          : c.effective.sudo
            ? t("no — but sudo -n works")
            : t("no — and sudo -n is not available"),
      },
      {
        label: t("Directory writable"),
        value: c.effective.dirWritable
          ? t("yes")
          : c.effective.configPath
            ? t("no")
            : "—",
      },
      { label: t("Privilege"), value: c.effective.privilege || t("none"), mono: true },
      { label: t("Management API"), value: s.apiEnabled ? t("enabled") : t("not configured") },
      { label: t("Observatory"), value: s.observatory ? t("enabled") : t("not configured") },
      { label: t("Log"), value: s.logPath || t("not configured"), mono: true },
      { label: t("Domain strategy"), value: s.domainStrategy || t("default") },
    ];

    // The write path needs the config file AND its directory: the backup is
    // kept next to the file and the new one is put in place by a rename.
    let writeNote = "";
    if (c.effective.configPath && !c.effective.writable && !c.effective.sudo) {
      writeNote = t(
        "This user may not write the config and `sudo -n` does not work here, so the panel can read the configuration but cannot change it. Give the SSH user ownership of the config and its directory, or allow NOPASSWD sudo for the write and the restart.",
      );
    } else if (c.effective.configPath && c.effective.writable && !c.effective.dirWritable) {
      writeNote = t(
        "The config file is writable but its directory is not. The panel keeps its backup next to the file and replaces it by a rename, so it needs write access to the directory too.",
      );
    }

    return h(
      "div",
      { className: "flex min-h-0 flex-1 flex-col" },
      h(
        Toolbar,
        {},
        h(Button, {
          label: t("Probe the live path"),
          size: "xs",
          busy: c.isBusy("probe"),
          onClick: c.probePath,
          title: t("Measures a request through the local SOCKS inbound"),
        }),
        h(Button, {
          label: t("Add group"),
          size: "xs",
          onClick: () => c.openModal("group", { tag: "", selector: "", strategy: "random", fallbackTag: "" }),
        }),
        h(Button, {
          label: t("Add subscription"),
          size: "xs",
          onClick: () => c.openModal("subscription", { name: "", url: "", prefix: "" }),
        }),
      ),
      h(
        "div",
        { className: "min-h-0 flex-1 overflow-auto p-3" },
        h(
          "div",
          { className: "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" },
          h(StatTile, { label: t("Inbounds"), value: s.inboundCount }),
          h(StatTile, { label: t("Outbounds"), value: s.outboundCount }),
          h(StatTile, { label: t("Nodes"), value: s.nodeCount }),
          h(StatTile, { label: t("Groups"), value: s.groupCount }),
          h(StatTile, { label: t("Routing rules"), value: s.ruleCount }),
        ),
        h(
          "div",
          { className: "mt-3 rounded-lg border border-border bg-surface/40 p-3" },
          h(KeyValue, { rows, columns: 2 }),
        ),
        s.observatory
          ? h(
              "p",
              { className: "mt-3 text-[11px] text-muted" },
              t("The observatory is enabled: the delays in the Nodes tab are read from the xray log."),
            )
          : h(
              "p",
              { className: "mt-3 text-[11px] text-muted" },
              t(
                "Without an observatory in the config, xray measures nothing on its own — the delay column stays empty. The live path can still be probed.",
              ),
            ),
        writeNote
          ? h(
              "p",
              { className: "mt-2 text-[11px] text-warning" },
              writeNote,
            )
          : null,
      ),
    );
  };
}
