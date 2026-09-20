// The `docker run` form.
//
// The preview doubles as validation: the same builder the action uses is called
// on every keystroke, so a value the CLI layer would refuse is reported before
// the user commits to it — and the user can see (and copy) the exact command.

import { runCommand } from "../docker.js";
import { splitLines } from "./format.js";

export function createRunModal({ h, ui, t }) {
  const { Button, Checkbox, CopyButton, Field, Modal, Select, TextArea, TextInput, useMemo, useState } =
    ui;

  const LineList = (props) => h(TextArea, { rows: 3, ...props });

  return function RunModal({ c }) {
    const [form, setForm] = useState({
      image: c.modal.image || "",
      name: "",
      command: "",
      ports: "",
      env: "",
      volumes: "",
      network: "",
      restart: "",
      workdir: "",
      user: "",
      memory: "",
      cpus: "",
      autoRemove: false,
      publishAll: false,
      privileged: false,
      detach: true,
    });
    const patch = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

    const spec = useMemo(
      () => ({
        image: form.image.trim(),
        name: form.name.trim() || undefined,
        command: form.command.trim() || undefined,
        ports: splitLines(form.ports),
        env: splitLines(form.env),
        volumes: splitLines(form.volumes),
        network: form.network.trim() || undefined,
        restart: form.restart || undefined,
        workdir: form.workdir.trim() || undefined,
        user: form.user.trim() || undefined,
        memory: form.memory.trim() || undefined,
        cpus: form.cpus.trim() || undefined,
        autoRemove: form.autoRemove,
        publishAll: form.publishAll,
        privileged: form.privileged,
        detach: form.detach,
      }),
      [form],
    );

    const preview = useMemo(() => {
      if (!spec.image) {
        return { text: "", error: "" };
      }
      try {
        return { text: runCommand(spec, { bin: c.bin }), error: "" };
      } catch (error) {
        return { text: "", error: String(error.message || error) };
      }
    }, [spec, c.bin]);

    return h(
      Modal,
      {
        title: t("Run a container"),
        description: t("docker run — the fields below map to its flags."),
        onClose: c.closeModal,
        width: "max-w-2xl",
        actions: [
          h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
          h(Button, {
            key: "run",
            label: t("Run"),
            tone: "primary",
            disabled: !preview.text,
            onClick: () => {
              c.closeModal();
              c.task(`run:${spec.image}`, `docker run ${spec.image}`, () => c.client.run(spec));
            },
          }),
        ],
      },
      h(
        "div",
        { className: "grid grid-cols-2 gap-3" },
        h(
          Field,
          { label: t("Image"), hint: t("Required. e.g. nginx:1.27") },
          h(TextInput, {
            value: form.image,
            onChange: patch("image"),
            placeholder: "nginx:1.27",
            autoFocus: true,
          }),
        ),
        h(
          Field,
          { label: t("Name"), hint: "--name" },
          h(TextInput, { value: form.name, onChange: patch("name"), placeholder: "web" }),
        ),
        h(
          Field,
          { label: t("Ports"), hint: t("-p, one per line: 8080:80"), wide: true },
          h(LineList, {
            value: form.ports,
            onChange: patch("ports"),
            placeholder: "8080:80\n127.0.0.1:5432:5432/tcp",
          }),
        ),
        h(
          Field,
          { label: t("Environment"), hint: t("-e, one KEY=value per line") },
          h(LineList, { value: form.env, onChange: patch("env"), placeholder: "TZ=UTC" }),
        ),
        h(
          Field,
          { label: t("Mounts"), hint: t("-v, one source:target[:ro] per line") },
          h(LineList, {
            value: form.volumes,
            onChange: patch("volumes"),
            placeholder: "/srv/data:/data:ro",
          }),
        ),
        h(
          Field,
          { label: t("Network"), hint: "--network" },
          h(TextInput, { value: form.network, onChange: patch("network"), placeholder: "bridge" }),
        ),
        h(
          Field,
          { label: t("Restart policy"), hint: "--restart" },
          h(Select, {
            value: form.restart,
            onChange: patch("restart"),
            options: [
              { value: "", label: t("(default) no") },
              { value: "always", label: "always" },
              { value: "unless-stopped", label: "unless-stopped" },
              { value: "on-failure", label: "on-failure" },
            ],
          }),
        ),
        h(
          Field,
          { label: t("Working dir"), hint: "-w" },
          h(TextInput, { value: form.workdir, onChange: patch("workdir"), placeholder: "/app" }),
        ),
        h(
          Field,
          { label: t("User"), hint: "-u" },
          h(TextInput, { value: form.user, onChange: patch("user"), placeholder: "1000:1000" }),
        ),
        h(
          Field,
          { label: t("Memory limit"), hint: "--memory" },
          h(TextInput, { value: form.memory, onChange: patch("memory"), placeholder: "512m" }),
        ),
        h(
          Field,
          { label: t("CPUs"), hint: "--cpus" },
          h(TextInput, { value: form.cpus, onChange: patch("cpus"), placeholder: "1.5" }),
        ),
        h(
          Field,
          { label: t("Command"), hint: t("Override the image command (argv)"), wide: true },
          h(TextInput, {
            value: form.command,
            onChange: patch("command"),
            placeholder: "nginx -g 'daemon off;'",
          }),
        ),
        h(
          "div",
          { className: "col-span-2 flex flex-wrap items-center gap-3" },
          h(Checkbox, {
            checked: form.detach,
            onChange: patch("detach"),
            label: t("Detached (-d)"),
            title: t("Required for a long-running container: this channel cannot attach to one."),
          }),
          h(Checkbox, { checked: form.autoRemove, onChange: patch("autoRemove"), label: "--rm" }),
          h(Checkbox, { checked: form.publishAll, onChange: patch("publishAll"), label: "-P" }),
          h(Checkbox, {
            checked: form.privileged,
            onChange: patch("privileged"),
            label: "--privileged",
          }),
        ),
      ),
      h(
        "div",
        { className: "mt-3 rounded-lg border border-border bg-surface/40 p-2" },
        h(
          "div",
          { className: "mb-1 flex items-center justify-between gap-2" },
          h(
            "span",
            { className: "text-[10px] tracking-wide text-muted uppercase" },
            t("Command preview"),
          ),
          preview.text ? h(CopyButton, { value: preview.text, label: t("Copy") }) : null,
        ),
        preview.error
          ? h("p", { className: "font-mono text-[11px] text-danger" }, preview.error)
          : h(
              "p",
              { className: "font-mono text-[11px] break-all text-text" },
              preview.text || t("Enter an image to see the command."),
            ),
      ),
    );
  };
}
