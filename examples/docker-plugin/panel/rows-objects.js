// The volume, network and event tables.

import { copyText, shortTime } from "./format.js";

export function createObjectRows({ h, ui, t }) {
  const { Button, Menu, Mono, Pill } = ui;

  const volumeColumns = (c) => [
    {
      key: "name",
      label: t("Name"),
      width: "minmax(160px,1.4fr)",
      render: (volume) =>
        h("span", { className: "truncate font-medium", title: volume.name }, volume.name),
    },
    { key: "driver", label: t("Driver"), width: "90px", render: (volume) => volume.driver },
    {
      key: "mountpoint",
      label: t("Mount point"),
      width: "minmax(180px,2fr)",
      render: (volume) =>
        h(Mono, { className: "truncate text-muted", title: volume.mountpoint }, volume.mountpoint),
    },
    {
      key: "actions",
      label: "",
      width: "120px",
      render: (volume) =>
        h(
          "div",
          { className: "flex items-center justify-end gap-1" },
          h(Button, {
            label: t("Inspect"),
            size: "xs",
            title: `docker volume inspect ${volume.name}`,
            onClick: () => c.openInspect("volume", volume.name, volume.name),
          }),
          h(Menu, {
            items: [
              {
                key: "copy",
                label: t("Copy mount point"),
                onClick: () => copyText(volume.mountpoint),
              },
              { separator: true },
              {
                key: "rm",
                label: t("Remove"),
                hint: "docker volume rm",
                tone: "danger",
                onClick: () =>
                  c.askConfirm({
                    title: t("Remove this volume?"),
                    body: t("The data in it is deleted and cannot be recovered."),
                    command: `docker volume rm ${volume.name}`,
                    confirmLabel: t("Remove"),
                    tone: "danger",
                    run: () =>
                      c.task(volume.name, `docker volume rm ${volume.name}`, () =>
                        c.client.removeVolume(volume.name),
                      ),
                  }),
              },
            ],
          }),
        ),
    },
  ];

  const networkColumns = (c) => [
    {
      key: "name",
      label: t("Name"),
      width: "minmax(140px,1.3fr)",
      render: (network) =>
        h(
          "div",
          { className: "flex min-w-0 items-center gap-1.5" },
          h("span", { className: "truncate font-medium", title: network.name }, network.name),
          network.internal ? h(Pill, { tone: "warning" }, "internal") : null,
          network.predefined ? h(Pill, null, t("built-in")) : null,
        ),
    },
    { key: "driver", label: t("Driver"), width: "90px", render: (network) => network.driver },
    { key: "scope", label: t("Scope"), width: "80px", render: (network) => network.scope },
    {
      key: "id",
      label: t("Id"),
      width: "110px",
      render: (network) => h(Mono, { className: "text-muted", title: network.id }, network.shortId),
    },
    {
      key: "actions",
      label: "",
      width: "120px",
      render: (network) =>
        h(
          "div",
          { className: "flex items-center justify-end gap-1" },
          h(Button, {
            label: t("Inspect"),
            size: "xs",
            title: `docker network inspect ${network.name}`,
            onClick: () => c.openInspect("network", network.name, network.name),
          }),
          h(Menu, {
            items: [
              {
                key: "connect",
                label: t("Connect a container…"),
                hint: "docker network connect",
                onClick: () => c.openModal({ kind: "connect", network: network.name }),
              },
              { separator: true },
              {
                key: "rm",
                label: t("Remove"),
                hint: "docker network rm",
                tone: "danger",
                // docker refuses to remove bridge / host / none.
                disabled: network.predefined,
                onClick: () =>
                  c.askConfirm({
                    title: t("Remove this network?"),
                    command: `docker network rm ${network.name}`,
                    confirmLabel: t("Remove"),
                    tone: "danger",
                    run: () =>
                      c.task(network.name, `docker network rm ${network.name}`, () =>
                        c.client.removeNetwork(network.name),
                      ),
                  }),
              },
            ],
          }),
        ),
    },
  ];

  const eventColumns = () => [
    {
      key: "time",
      label: t("Time"),
      width: "160px",
      render: (event) => h(Mono, { className: "text-muted" }, shortTime(event.time)),
    },
    { key: "type", label: t("Type"), width: "90px", render: (event) => h(Pill, null, event.type) },
    {
      key: "action",
      label: t("Action"),
      width: "minmax(100px,1fr)",
      render: (event) => h("span", { className: "truncate font-medium" }, event.action),
    },
    {
      key: "name",
      label: t("Object"),
      width: "minmax(120px,1.4fr)",
      render: (event) =>
        h("span", { className: "truncate", title: event.id }, event.name || event.id.slice(0, 12)),
    },
    {
      key: "image",
      label: t("Image"),
      width: "minmax(100px,1.2fr)",
      render: (event) =>
        h("span", { className: "truncate text-muted", title: event.image }, event.image),
    },
  ];

  return { eventColumns, networkColumns, volumeColumns };
}
