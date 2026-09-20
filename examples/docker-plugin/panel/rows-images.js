// The image table: columns plus the per-row menu (history, inspect, tag, push,
// remove). A dangling image is addressed by id, a tagged one by reference —
// which is what `docker rmi` and `docker run` each expect.

import { copyText } from "./format.js";

export function createImageRows({ h, ui, t }) {
  const { Button, Menu, Mono, Pill } = ui;

  const menuItems = (c, image, reference) => [
    { key: "history", label: t("History"), hint: "docker history", onClick: () => c.openHistory(image) },
    {
      key: "inspect",
      label: t("Inspect"),
      hint: "docker inspect",
      onClick: () => c.openInspect("image", reference, image.reference),
    },
    {
      key: "pull",
      label: t("Pull again"),
      hint: "docker pull",
      disabled: image.dangling,
      onClick: () =>
        c.task(image.id, `docker pull ${image.reference}`, () => c.client.pull(image.reference)),
    },
    {
      key: "tag",
      label: t("Tag…"),
      hint: "docker tag",
      onClick: () => c.openModal({ kind: "tag", source: reference }),
    },
    {
      key: "push",
      label: t("Push"),
      hint: "docker push",
      disabled: image.dangling,
      onClick: () =>
        c.askConfirm({
          title: t("Push this image?"),
          description: t("This uploads the image to its registry."),
          command: `docker push ${image.reference}`,
          confirmLabel: t("Push"),
          run: () =>
            c.task(image.id, `docker push ${image.reference}`, () => c.client.push(image.reference)),
        }),
    },
    { key: "copy", label: t("Copy image id"), onClick: () => copyText(image.id) },
    { separator: true },
    {
      key: "rm",
      label: t("Remove"),
      hint: "docker rmi",
      tone: "danger",
      onClick: () =>
        c.askConfirm({
          title: t("Remove this image?"),
          body: t("Use force if a stopped container still references it."),
          command: `docker rmi ${reference}`,
          confirmLabel: t("Remove"),
          tone: "danger",
          run: () =>
            c.task(image.id, `docker rmi ${image.reference}`, () => c.client.removeImage(reference)),
        }),
    },
    {
      key: "rmf",
      label: t("Force remove"),
      hint: "docker rmi -f",
      tone: "danger",
      onClick: () =>
        c.askConfirm({
          title: t("Force-remove this image?"),
          command: `docker rmi -f ${reference}`,
          confirmLabel: t("Force remove"),
          tone: "danger",
          run: () =>
            c.task(image.id, `docker rmi -f ${image.reference}`, () =>
              c.client.removeImage(reference, { force: true }),
            ),
        }),
    },
  ];

  const imageColumns = (c) => [
    {
      key: "reference",
      label: t("Repository:Tag"),
      width: "minmax(180px,2fr)",
      render: (image) =>
        h(
          "div",
          { className: "flex min-w-0 items-center gap-1.5" },
          h("span", { className: "truncate font-medium", title: image.reference }, image.reference),
          image.dangling ? h(Pill, { tone: "warning" }, t("dangling")) : null,
        ),
    },
    {
      key: "id",
      label: t("Image id"),
      width: "110px",
      render: (image) => h(Mono, { className: "text-muted", title: image.id }, image.shortId),
    },
    { key: "size", label: t("Size"), width: "84px", align: "right", render: (image) => image.size },
    {
      key: "created",
      label: t("Created"),
      width: "minmax(90px,120px)",
      render: (image) =>
        h("span", { className: "truncate text-muted", title: image.createdAt }, image.createdSince),
    },
    {
      key: "actions",
      label: "",
      width: "150px",
      render: (image) => {
        const reference = image.dangling ? image.id : image.reference;
        return h(
          "div",
          { className: "flex items-center justify-end gap-1" },
          h(Button, {
            label: t("Run…"),
            size: "xs",
            title: `docker run ${reference}`,
            onClick: () => c.openModal({ kind: "run", image: reference }),
          }),
          h(Menu, { items: menuItems(c, image, reference) }),
        );
      },
    },
  ];

  return { imageColumns };
}
