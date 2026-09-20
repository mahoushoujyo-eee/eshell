// The header: what cluster and namespace the panel is pointed at, the resource
// type tabs, and the two chrome buttons.
//
// The context and namespace pickers set `--context` and `-n` for every
// subsequent command. They deliberately do NOT run `kubectl config use-context`:
// that would rewrite the host's kubeconfig, changing what every other user and
// script on that machine sees.

import { KINDS } from "../kinds.js";

export function createHeader({ h, ui, t }) {
  const { Button, Pill, Select, Tabs, TextInput } = ui;

  const ScopePickers = ({ c }) =>
    h(
      "div",
      { className: "flex min-w-0 shrink items-center gap-1.5" },
      h(Select, {
        value: c.context,
        onChange: c.setContext,
        title: "--context",
        className: "max-w-44",
        options: [
          {
            value: "",
            label: c.currentContext
              ? t("current: {context}", { context: c.currentContext })
              : t("(kubeconfig default)"),
          },
          ...c.contexts.map((name) => ({ value: name, label: name })),
        ],
      }),
      h(Select, {
        value: c.allNamespaces ? "__all" : c.namespace,
        onChange: (value) => {
          if (value === "__all") {
            c.setAllNamespaces(true);
            return;
          }
          c.setAllNamespaces(false);
          c.setNamespace(value);
        },
        title: "-n / --all-namespaces",
        className: "max-w-40",
        options: [
          { value: "", label: t("(default namespace)") },
          { value: "__all", label: t("all namespaces (-A)") },
          ...c.namespaces.map((name) => ({ value: name, label: name })),
        ],
      }),
    );

  const KindTabs = ({ c }) =>
    h(Tabs, {
      value: c.customKind ? "" : c.kindKey,
      onChange: (value) => {
        c.setCustomKind("");
        c.setKindKey(value);
      },
      items: KINDS.map((entry) => ({
        id: entry.key,
        label: t(entry.label),
        title: `kubectl get ${entry.kind}`,
      })),
    });

  /** `kubectl get <anything>`: the tabs are a shortcut, not the limit. */
  const CustomKind = ({ c }) =>
    h(TextInput, {
      value: c.customKind,
      onChange: c.setCustomKind,
      placeholder: t("other type…"),
      ariaLabel: t("Another resource type"),
      className: "w-28",
    });

  return function Header({ c }) {
    return h(
      "div",
      { className: "shrink-0 border-b border-border" },
      h(
        "div",
        { className: "flex items-center gap-2 px-3 py-2" },
        h(
          "div",
          { className: "flex min-w-0 items-center gap-1.5" },
          h("span", { className: "text-sm font-semibold" }, "Kubernetes"),
          c.hostLabel
            ? h(Pill, { tone: "info", title: t("Active SSH session") }, c.hostLabel)
            : h(Pill, null, t("no session")),
          c.version && c.version.serverVersion
            ? h(Pill, { title: t("API server version") }, c.version.serverVersion)
            : null,
          c.bin !== "kubectl" ? h(Pill, { tone: "warning", title: t("CLI prefix") }, c.bin) : null,
        ),
        h("div", { className: "ml-auto flex min-w-0 shrink items-center gap-1.5" }, h(ScopePickers, { c }),
          h(Button, {
            label: t("Refresh"),
            size: "xs",
            busy: c.loading,
            disabled: !c.hasSession,
            title: t("Re-read the listing"),
            onClick: c.refresh,
          }),
          h(Button, {
            label: "⚙",
            size: "xs",
            tone: "ghost",
            title: t("Panel settings"),
            onClick: () => c.openModal({ kind: "settings" }),
          }),
        ),
      ),
      h(
        "div",
        { className: "flex items-center gap-2 border-t border-border/60 px-3 py-1" },
        h(KindTabs, { c }),
        h("div", { className: "ml-auto flex shrink-0 items-center gap-1.5" }, h(CustomKind, { c })),
      ),
    );
  };
}
