// The dialogs: scale, apply, port-forward, panel settings, and the confirmation
// box every destructive verb goes through.

import { AUTO_REFRESH_OPTIONS } from "../controller/index.js";
import { applyCommand } from "../kubectl.js";
import { copyText } from "./format.js";

export function createModals({ h, ui, t }) {
  const { Button, Checkbox, CopyButton, Field, Modal, Select, TextArea, TextInput, useMemo, useState } =
    ui;

  const ScaleModal = ({ c }) => {
    const row = c.modal.row;
    const current = row.byName.READY || row.byName.REPLICAS || "";
    const [replicas, setReplicas] = useState(() => {
      const match = /^(\d+)/.exec(current);
      return match ? match[1] : "1";
    });
    const count = Number(replicas);
    const valid = Number.isInteger(count) && count >= 0 && count <= 10_000;
    const command = `kubectl scale ${c.descriptor.kind}/${row.name} --replicas=${valid ? count : "?"}`;
    const submit = () => {
      if (!valid) {
        return;
      }
      c.closeModal();
      const apply = () =>
        c.task(row.key, `kubectl scale ${row.name} --replicas=${count}`, () =>
          c.clientFor(row).scale(c.descriptor.kind, row.name, count),
        );
      if (count === 0) {
        c.askConfirm({
          title: t("Scale to zero?"),
          body: t("Every pod of this workload is removed. Nothing serves traffic until it is scaled back up."),
          command,
          confirmLabel: t("Scale to zero"),
          tone: "danger",
          run: apply,
        });
        return;
      }
      apply();
    };
    return h(
      Modal,
      {
        title: t("Scale {name}", { name: row.name }),
        description: command,
        onClose: c.closeModal,
        width: "max-w-md",
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
          h(Button, {
            key: "ok",
            label: t("Scale"),
            tone: count === 0 ? "danger" : "primary",
            disabled: !valid,
            onClick: submit,
          }),
        ],
      },
      h(
        Field,
        { label: t("Replicas"), hint: t("Currently {current}", { current: current || "?" }) },
        h(TextInput, {
          value: replicas,
          onChange: setReplicas,
          onEnter: submit,
          autoFocus: true,
          className: "w-24",
        }),
      ),
    );
  };

  const ApplyModal = ({ c }) => {
    const [manifest, setManifest] = useState("");
    const preview = useMemo(() => {
      if (!manifest.trim()) {
        return { ok: false, error: "" };
      }
      try {
        applyCommand(manifest, { dryRun: true }, { bin: c.bin });
        return { ok: true, error: "" };
      } catch (error) {
        return { ok: false, error: String(error.message || error) };
      }
    }, [manifest, c.bin]);

    const submit = (dryRun) => {
      if (!preview.ok) {
        return;
      }
      const label = dryRun ? "kubectl apply --dry-run=server" : "kubectl apply -f -";
      if (dryRun) {
        c.openText(t("Apply (dry run)"), label, () => c.client.apply(manifest, { dryRun: true }));
        return;
      }
      c.closeModal();
      c.task("apply", label, () => c.client.apply(manifest));
    };

    return h(
      Modal,
      {
        title: t("Apply a manifest"),
        description: t("kubectl apply -f - — the document is piped in, never written to the host."),
        onClose: c.closeModal,
        width: "max-w-2xl",
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
          h(Button, {
            key: "dry",
            label: t("Dry run"),
            disabled: !preview.ok,
            title: "--dry-run=server",
            onClick: () => submit(true),
          }),
          h(Button, {
            key: "ok",
            label: t("Apply"),
            tone: "primary",
            disabled: !preview.ok,
            onClick: () => submit(false),
          }),
        ],
      },
      h(
        Field,
        {
          label: t("Manifest"),
          hint: t("Applied in the namespace selected in the header unless the document names one."),
        },
        h(TextArea, {
          value: manifest,
          onChange: setManifest,
          rows: 14,
          placeholder: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\ndata:\n  key: value",
          autoFocus: true,
        }),
      ),
      preview.error ? h("p", { className: "mt-2 text-[11px] text-danger" }, preview.error) : null,
      h(
        "p",
        { className: "mt-2 text-[11px] text-muted" },
        t("Dry run asks the API server to validate without persisting. --prune is never used."),
      ),
    );
  };

  const PortForwardModal = ({ c }) => {
    const row = c.modal.row;
    const [mapping, setMapping] = useState("8080:80");
    const command = useMemo(() => {
      try {
        // The row's own namespace, not the panel's: in `-A` mode a
        // `port-forward` with `--all-namespaces` is not a valid command.
        return c.clientFor(row).portForwardLine("pods", row.name, mapping);
      } catch (error) {
        return String(error.message || error);
      }
    }, [c, mapping, row]);
    return h(
      Modal,
      {
        title: t("Port forward"),
        description: t("This one has to run in a terminal tab: it holds the connection open until interrupted, and this panel's channel cannot interrupt a command."),
        onClose: c.closeModal,
        width: "max-w-lg",
        actions: [
          h(Button, { key: "close", label: t("Close"), onClick: c.closeModal }),
          h(Button, {
            key: "copy",
            label: t("Copy command"),
            tone: "primary",
            onClick: () => {
              copyText(command);
              c.closeModal();
              c.say("success", t("Command copied — paste it into a terminal tab."));
            },
          }),
        ],
      },
      h(
        Field,
        { label: t("Ports"), hint: t("local:remote, or one port for both") },
        h(TextInput, { value: mapping, onChange: setMapping, autoFocus: true, className: "w-32" }),
      ),
      h(
        "p",
        {
          className:
            "mt-3 rounded-md border border-border bg-surface/50 p-2 font-mono text-[11px] break-all",
        },
        command,
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
              "What runs on the host. Use `k3s kubectl` or `microk8s kubectl` on those distributions, or `env KUBECONFIG=/path kubectl` when the config is not at ~/.kube/config.",
            ),
          },
          h(
            "div",
            { className: "flex items-center gap-1.5" },
            h(TextInput, {
              value: c.binDraft,
              onChange: c.setBinDraft,
              onEnter: c.applyBin,
              placeholder: "kubectl",
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
            hint: t("Re-reads the listing. Paused while a dialog is open."),
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
          checked: c.hideNoisy,
          onChange: c.setHideNoisy,
          label: t("Hide the mostly-empty -o wide columns"),
          title: "NOMINATED NODE, READINESS GATES, SELECTOR",
        }),
        h(
          "p",
          { className: "text-[10px] text-muted" },
          t("The context and namespace are passed per command; the host's kubeconfig is never rewritten."),
        ),
      ),
    );

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
      c.confirm.command
        ? h(
            "div",
            { className: "mt-2 flex justify-end" },
            h(CopyButton, { value: c.confirm.command, label: t("Copy command") }),
          )
        : null,
    );

  const MODALS = {
    scale: ScaleModal,
    apply: ApplyModal,
    portForward: PortForwardModal,
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
