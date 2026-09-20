// The dialog dispatcher, plus the three dialogs that are not a plain form:
// Docker Hub search, panel settings, and the confirmation box.

import { AUTO_REFRESH_OPTIONS } from "../controller/index.js";
import { createFormModals } from "./modal-forms.js";
import { createRunModal } from "./modal-run.js";

export function createModals(ctx) {
  const { h, ui, t } = ctx;
  const { Button, Checkbox, Field, Modal, Pill, Select, TextInput, useState } = ui;
  const RunModal = createRunModal(ctx);
  const forms = createFormModals(ctx);

  const SearchModal = ({ c }) => {
    const [term, setTerm] = useState(c.searchState.term || "");
    const rows = c.searchState.rows;
    return h(
      Modal,
      {
        title: t("Search Docker Hub"),
        description: "docker search",
        onClose: c.closeModal,
        width: "max-w-2xl",
        actions: [h(Button, { key: "close", label: t("Close"), onClick: c.closeModal })],
      },
      h(
        "div",
        { className: "mb-3 flex items-center gap-1.5" },
        h(TextInput, {
          value: term,
          onChange: setTerm,
          onEnter: () => c.runSearch(term),
          placeholder: "nginx",
          className: "flex-1",
          autoFocus: true,
        }),
        h(Button, {
          label: t("Search"),
          tone: "primary",
          busy: c.searchState.pending,
          onClick: () => c.runSearch(term),
        }),
      ),
      c.searchState.error
        ? h("p", { className: "text-[11px] text-danger" }, c.searchState.error)
        : null,
      rows.length === 0
        ? h(
            "p",
            { className: "text-[11px] text-muted" },
            c.searchState.pending ? t("Searching…") : t("No results yet."),
          )
        : h(
            "div",
            { className: "flex flex-col gap-1" },
            rows.map((row) =>
              h(
                "div",
                {
                  key: row.name,
                  className: "flex items-start gap-2 rounded-md border border-border px-2 py-1.5",
                },
                h(
                  "div",
                  { className: "min-w-0 flex-1" },
                  h(
                    "div",
                    { className: "flex items-center gap-1.5" },
                    h("span", { className: "truncate text-[11px] font-medium" }, row.name),
                    row.official ? h(Pill, { tone: "info" }, t("official")) : null,
                    h("span", { className: "shrink-0 text-[10px] text-muted" }, `★ ${row.stars}`),
                  ),
                  h(
                    "p",
                    { className: "truncate text-[10px] text-muted", title: row.description },
                    row.description,
                  ),
                ),
                h(Button, {
                  label: t("Pull"),
                  size: "xs",
                  onClick: () => c.openModal({ kind: "pull", reference: row.name }),
                }),
              ),
            ),
          ),
    );
  };

  const SettingsModal = ({ c }) =>
    h(
      Modal,
      {
        title: t("Panel settings"),
        onClose: c.closeModal,
        actions: [h(Button, { key: "close", label: t("Close"), onClick: c.closeModal })],
      },
      h(
        "div",
        { className: "flex flex-col gap-3" },
        h(
          Field,
          {
            label: t("CLI prefix"),
            hint: t(
              "What runs on the host. Use `sudo -n docker` when the SSH user is not in the docker group, or an absolute path when docker is outside the non-interactive PATH.",
            ),
          },
          h(
            "div",
            { className: "flex items-center gap-1.5" },
            h(TextInput, {
              value: c.binDraft,
              onChange: c.setBinDraft,
              onEnter: c.applyBin,
              placeholder: "docker",
              className: "flex-1 font-mono",
            }),
            h(Button, { label: t("Apply"), tone: "primary", onClick: c.applyBin }),
            h(Button, { label: t("Reset"), onClick: c.resetBin }),
          ),
        ),
        h(
          Field,
          {
            label: t("Auto refresh"),
            hint: t("Re-reads the open tab. Paused while a dialog is open."),
          },
          h(Select, {
            value: c.autoRefresh,
            onChange: (value) => c.setAutoRefresh(Number(value)),
            options: AUTO_REFRESH_OPTIONS.map((seconds) => ({
              value: seconds,
              label: seconds === 0 ? t("off") : `${seconds}s`,
            })),
          }),
        ),
        h(Checkbox, {
          checked: c.statsEnabled,
          onChange: c.setStatsEnabled,
          label: t("Live CPU / memory (docker stats)"),
          title: "docker stats --no-stream",
        }),
        h(
          "p",
          { className: "text-[10px] text-muted" },
          t("Settings are stored per plugin, not per host."),
        ),
      ),
    );

  /** Every destructive action routes through here, with the exact command shown. */
  const ConfirmModal = ({ c }) =>
    h(
      Modal,
      {
        title: c.confirm.title,
        description: c.confirm.description,
        onClose: c.closeConfirm,
        width: "max-w-md",
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeConfirm }),
          h(Button, {
            key: "ok",
            label: c.confirm.confirmLabel || t("Confirm"),
            tone: c.confirm.tone === "danger" ? "danger" : "primary",
            onClick: c.runConfirm,
          }),
        ],
      },
      c.confirm.command
        ? h(
            "p",
            {
              className:
                "rounded-md border border-border bg-surface/50 p-2 font-mono text-[11px] break-all",
            },
            c.confirm.command,
          )
        : null,
      c.confirm.body ? h("p", { className: "mt-2 text-[11px] text-muted" }, c.confirm.body) : null,
    );

  const MODALS = {
    run: RunModal,
    pull: forms.PullModal,
    tag: forms.TagModal,
    rename: forms.RenameModal,
    createVolume: forms.CreateVolumeModal,
    createNetwork: forms.CreateNetworkModal,
    connect: forms.ConnectModal,
    search: SearchModal,
    settings: SettingsModal,
  };

  return {
    modalFor(c) {
      if (!c.modal) {
        return null;
      }
      const Component = MODALS[c.modal.kind];
      return Component ? h(Component, { c }) : null;
    },
    confirmFor(c) {
      return c.confirm ? h(ConfirmModal, { c }) : null;
    },
  };
}
