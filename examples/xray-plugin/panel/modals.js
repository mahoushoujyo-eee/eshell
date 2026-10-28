// The modals: the group form, the subscription form, the settings form, and
// the confirmation a destructive or disruptive action waits for.
//
// Each form keeps its own draft state and commits only on save, so a
// half-typed path never triggers a re-detection on the host.

import { isSafeTag, isSafeUrl } from "../cli/validate.js";
import { STRATEGY_LABELS } from "../controller/derive.js";
import { STRATEGIES } from "../cli/validate.js";

export function createModals(ctx) {
  const { h, ui, t } = ctx;
  const { Button, Field, Modal, Mono, Select, TextInput } = ui;
  const { useState } = ui;

  const GroupModal = ({ c }) => {
    const draft = c.modal;
    const [tag, setTag] = useState(draft.tag || "");
    const [selector, setSelector] = useState(draft.selector || "");
    const [strategy, setStrategy] = useState(draft.strategy || "random");
    const [fallbackTag, setFallbackTag] = useState(draft.fallbackTag || "");

    const prefixes = String(selector)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const tagValid = isSafeTag(tag);
    const prefixesValid = prefixes.every((prefix) => isSafeTag(prefix));
    const canSave = tagValid && prefixesValid && prefixes.length > 0;

    return h(
      Modal,
      {
        title: draft.tag ? t("Edit the group") : t("Add a group"),
        description: t(
          "A group is a balancer. Its selector holds the tag prefixes it picks between; the nodes of a subscription carry its prefix.",
        ),
        onClose: c.closeModal,
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
          h(Button, {
            key: "save",
            label: t("Save"),
            tone: "primary",
            disabled: !canSave,
            onClick: () => c.saveGroup({ tag, selector, strategy, fallbackTag }),
          }),
        ],
      },
      h(
        "div",
        { className: "grid gap-3 sm:grid-cols-2" },
        h(
          Field,
          {
            label: t("Tag"),
            hint: t("Letters, digits, dot, dash and underscore."),
          },
          h(TextInput, {
            value: tag,
            onChange: setTag,
            placeholder: "hk",
            autoFocus: true,
            ariaLabel: t("Tag"),
          }),
        ),
        h(
          Field,
          {
            label: t("Strategy"),
            hint: t("leastPing and leastLoad need an observatory in the config."),
          },
          h(Select, {
            value: strategy,
            ariaLabel: t("Strategy"),
            onChange: setStrategy,
            options: STRATEGIES.map((value) => ({
              value,
              label: STRATEGY_LABELS[value] || value,
            })),
          }),
        ),
        h(
          Field,
          {
            label: t("Selector"),
            wide: true,
            hint: t("Comma-separated tag prefixes. The nodes it selects are the outbounds whose tag starts with one of them."),
          },
          h(TextInput, {
            value: selector,
            onChange: setSelector,
            placeholder: "hk, jp",
            ariaLabel: t("Selector"),
          }),
        ),
        h(
          Field,
          {
            label: t("Fallback tag"),
            wide: true,
            hint: t("Optional. The outbound used when no node of the group can be reached."),
          },
          h(TextInput, {
            value: fallbackTag,
            onChange: setFallbackTag,
            placeholder: "direct",
            ariaLabel: t("Fallback tag"),
          }),
        ),
      ),
    );
  };

  const SubscriptionModal = ({ c }) => {
    const draft = c.modal;
    const [name, setName] = useState(draft.name || "");
    const [url, setUrl] = useState(draft.url || "");
    const [prefix, setPrefix] = useState(draft.prefix || "");

    const urlValid = isSafeUrl(url);
    const canSave = name.trim().length > 0 && urlValid;

    return h(
      Modal,
      {
        title: draft.id ? t("Edit the subscription") : t("Add a subscription"),
        description: t(
          "The link is fetched by the host. Its nodes are written into the config under the prefix, and a group selects them by that prefix.",
        ),
        onClose: c.closeModal,
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
          h(Button, {
            key: "save",
            label: t("Save"),
            tone: "primary",
            disabled: !canSave,
            onClick: () => c.saveSubscription({ id: draft.id, name, url, prefix }),
          }),
        ],
      },
      h(
        "div",
        { className: "grid gap-3 sm:grid-cols-2" },
        h(
          Field,
          { label: t("Name"), hint: t("Shown in the list.") },
          h(TextInput, {
            value: name,
            onChange: setName,
            placeholder: t("Hong Kong"),
            autoFocus: true,
            ariaLabel: t("Name"),
          }),
        ),
        h(
          Field,
          {
            label: t("Prefix"),
            hint: t("The tag prefix the nodes get. Leave empty to derive it from the name."),
          },
          h(TextInput, {
            value: prefix,
            onChange: setPrefix,
            placeholder: "hk",
            ariaLabel: t("Prefix"),
          }),
        ),
        h(
          Field,
          {
            label: t("URL"),
            wide: true,
            hint: t("An http(s) link. It carries your account token — the panel stores it locally and never shows it in full."),
          },
          h(TextInput, {
            value: url,
            onChange: setUrl,
            placeholder: "https://example.com/sub?token=…",
            ariaLabel: t("URL"),
          }),
        ),
      ),
    );
  };

  const SettingsModal = ({ c }) => {
    return h(
      Modal,
      {
        title: t("Settings"),
        description: t(
          "Leave a field empty to use what the host reports. The privilege prefix is used for the config write and the service restart — `sudo -n` never prompts.",
        ),
        onClose: c.closeModal,
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
          h(Button, {
            key: "save",
            label: t("Save"),
            tone: "primary",
            onClick: () => {
              c.applyBin();
              c.applyConfigPath();
              c.applyUnit();
              c.applyPrivilege();
              c.closeModal();
            },
          }),
        ],
      },
      h(
        "div",
        { className: "grid gap-3 sm:grid-cols-2" },
        h(
          Field,
          {
            label: t("Binary"),
            hint: c.info && c.info.bin ? t("Detected: {path}", { path: c.info.bin }) : "",
          },
          h(TextInput, {
            value: c.binDraft,
            onChange: c.setBinDraft,
            placeholder: "/usr/local/bin/xray",
            ariaLabel: t("Binary"),
          }),
        ),
        h(
          Field,
          {
            label: t("Config path"),
            hint:
              c.info && c.info.config
                ? t("Detected: {path}", { path: c.info.config })
                : "",
          },
          h(TextInput, {
            value: c.configPathDraft,
            onChange: c.setConfigPathDraft,
            placeholder: "/usr/local/etc/xray/config.json",
            ariaLabel: t("Config path"),
          }),
        ),
        h(
          Field,
          { label: t("Service"), hint: c.info && c.info.unit ? t("Detected: {name}", { name: c.info.unit }) : "" },
          h(TextInput, {
            value: c.unitDraft,
            onChange: c.setUnitDraft,
            placeholder: "xray.service",
            ariaLabel: t("Service"),
          }),
        ),
        h(
          Field,
          {
            label: t("Privilege prefix"),
            hint: t("Empty, or `sudo -n`. A plain sudo would wait for a password this channel cannot type."),
          },
          h(TextInput, {
            value: c.privilegeDraft,
            onChange: c.setPrivilegeDraft,
            placeholder: "sudo -n",
            ariaLabel: t("Privilege prefix"),
          }),
        ),
        h(
          Field,
          {
            label: t("Probe URL"),
            wide: true,
            hint: t("The address the latency probe asks for."),
          },
          h(TextInput, {
            value: c.probeUrl,
            onChange: c.setProbeUrl,
            placeholder: "https://www.gstatic.com/generate_204",
            ariaLabel: t("Probe URL"),
          }),
        ),
      ),
    );
  };

  const modalFor = (c) => {
    const request = c.modal;
    if (!request) {
      return null;
    }
    if (request.kind === "group") {
      return h(GroupModal, { key: `group-${request.id}`, c });
    }
    if (request.kind === "subscription") {
      return h(SubscriptionModal, { key: `subscription-${request.id}`, c });
    }
    if (request.kind === "settings") {
      return h(SettingsModal, { key: `settings-${request.id}`, c });
    }
    return null;
  };

  const confirmFor = (c) => {
    const request = c.confirm;
    if (!request) {
      return null;
    }
    return h(
      Modal,
      {
        title: request.title,
        description: request.description,
        onClose: c.closeConfirm,
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeConfirm }),
          h(Button, {
            key: "ok",
            label: request.confirmLabel || t("Confirm"),
            tone: request.tone === "primary" ? "primary" : "danger",
            busy: c.isBusy("confirm"),
            onClick: c.runConfirm,
          }),
        ],
      },
      request.command
        ? h(
            Mono,
            { className: "block rounded-md border border-border bg-surface/60 p-2 break-words" },
            request.command,
          )
        : null,
    );
  };

  return { modalFor, confirmFor };
}
