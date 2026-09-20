// The small `docker` forms: pull, tag, rename, create volume, create network,
// connect a container to a network.
//
// Each one submits through `c.task`, which reports the outcome in the notice bar
// and re-reads the open tab; none of them build a command themselves.

export function createFormModals({ h, ui, t }) {
  const { Button, Checkbox, Field, Modal, Select, TextInput, useState } = ui;

  /** Cancel + a primary action, the shape every form dialog here uses. */
  const formActions = (c, label, submit, disabled) => [
    h(Button, { key: "cancel", label: t("Cancel"), onClick: c.closeModal }),
    h(Button, { key: "ok", label, tone: "primary", disabled, onClick: submit }),
  ];

  const PullModal = ({ c }) => {
    const [reference, setReference] = useState(c.modal.reference || "");
    const [platform, setPlatform] = useState("");
    const submit = () => {
      const ref = reference.trim();
      if (!ref) {
        return;
      }
      c.closeModal();
      c.task(`pull:${ref}`, `docker pull ${ref}`, () =>
        c.client.pull(ref, { platform: platform.trim() || undefined }),
      );
    };
    return h(
      Modal,
      {
        title: t("Pull an image"),
        description: "docker pull",
        onClose: c.closeModal,
        actions: formActions(c, t("Pull"), submit, !reference.trim()),
      },
      h(
        "div",
        { className: "grid grid-cols-2 gap-3" },
        h(
          Field,
          { label: t("Reference"), hint: t("registry/name:tag or name@sha256:…"), wide: true },
          h(TextInput, {
            value: reference,
            onChange: setReference,
            onEnter: submit,
            placeholder: "nginx:1.27",
            autoFocus: true,
          }),
        ),
        h(
          Field,
          { label: t("Platform"), hint: "--platform" },
          h(TextInput, { value: platform, onChange: setPlatform, placeholder: "linux/arm64" }),
        ),
      ),
      h(
        "p",
        { className: "mt-3 text-[11px] text-muted" },
        t(
          "A pull runs to completion before the panel reports it; large images take a while and there is no progress stream.",
        ),
      ),
    );
  };

  const TagModal = ({ c }) => {
    const [target, setTarget] = useState("");
    const source = c.modal.source;
    const submit = () => {
      const wanted = target.trim();
      if (!wanted) {
        return;
      }
      c.closeModal();
      c.task(`tag:${wanted}`, `docker tag ${source} ${wanted}`, () => c.client.tag(source, wanted));
    };
    return h(
      Modal,
      {
        title: t("Tag an image"),
        description: `docker tag ${source} …`,
        onClose: c.closeModal,
        actions: formActions(c, t("Tag"), submit, !target.trim()),
      },
      h(
        Field,
        { label: t("New reference") },
        h(TextInput, {
          value: target,
          onChange: setTarget,
          onEnter: submit,
          placeholder: "registry.example.com/team/app:v2",
          autoFocus: true,
        }),
      ),
    );
  };

  const RenameModal = ({ c }) => {
    const [name, setName] = useState(c.modal.current || "");
    const submit = () => {
      const wanted = name.trim();
      if (!wanted || wanted === c.modal.current) {
        return;
      }
      c.closeModal();
      c.task(c.modal.reference, `docker rename ${c.modal.current} ${wanted}`, () =>
        c.client.rename(c.modal.reference, wanted),
      );
    };
    return h(
      Modal,
      {
        title: t("Rename container"),
        description: `docker rename ${c.modal.current} …`,
        onClose: c.closeModal,
        actions: formActions(c, t("Rename"), submit, !name.trim()),
      },
      h(
        Field,
        { label: t("New name") },
        h(TextInput, { value: name, onChange: setName, onEnter: submit, autoFocus: true }),
      ),
    );
  };

  const CreateVolumeModal = ({ c }) => {
    const [name, setName] = useState("");
    const [driver, setDriver] = useState("");
    const submit = () => {
      const wanted = name.trim();
      if (!wanted) {
        return;
      }
      c.closeModal();
      c.task(`volume:${wanted}`, `docker volume create ${wanted}`, () =>
        c.client.createVolume(wanted, { driver: driver.trim() || undefined }),
      );
    };
    return h(
      Modal,
      {
        title: t("Create a volume"),
        description: "docker volume create",
        onClose: c.closeModal,
        actions: formActions(c, t("Create"), submit, !name.trim()),
      },
      h(
        "div",
        { className: "grid grid-cols-2 gap-3" },
        h(
          Field,
          { label: t("Name") },
          h(TextInput, { value: name, onChange: setName, onEnter: submit, autoFocus: true }),
        ),
        h(
          Field,
          { label: t("Driver"), hint: "-d" },
          h(TextInput, { value: driver, onChange: setDriver, placeholder: "local" }),
        ),
      ),
    );
  };

  const CreateNetworkModal = ({ c }) => {
    const [form, setForm] = useState({
      name: "",
      driver: "bridge",
      subnet: "",
      gateway: "",
      internal: false,
      ipv6: false,
      attachable: false,
    });
    const patch = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
    const submit = () => {
      const wanted = form.name.trim();
      if (!wanted) {
        return;
      }
      c.closeModal();
      c.task(`network:${wanted}`, `docker network create ${wanted}`, () =>
        c.client.createNetwork(wanted, {
          driver: form.driver.trim() || undefined,
          subnet: form.subnet.trim() || undefined,
          gateway: form.gateway.trim() || undefined,
          internal: form.internal,
          ipv6: form.ipv6,
          attachable: form.attachable,
        }),
      );
    };
    return h(
      Modal,
      {
        title: t("Create a network"),
        description: "docker network create",
        onClose: c.closeModal,
        actions: formActions(c, t("Create"), submit, !form.name.trim()),
      },
      h(
        "div",
        { className: "grid grid-cols-2 gap-3" },
        h(
          Field,
          { label: t("Name") },
          h(TextInput, {
            value: form.name,
            onChange: patch("name"),
            onEnter: submit,
            autoFocus: true,
          }),
        ),
        h(
          Field,
          { label: t("Driver"), hint: "-d" },
          h(Select, {
            value: form.driver,
            onChange: patch("driver"),
            options: ["bridge", "overlay", "macvlan", "ipvlan"].map((driver) => ({
              value: driver,
              label: driver,
            })),
          }),
        ),
        h(
          Field,
          { label: t("Subnet"), hint: "--subnet" },
          h(TextInput, {
            value: form.subnet,
            onChange: patch("subnet"),
            placeholder: "172.30.0.0/16",
          }),
        ),
        h(
          Field,
          { label: t("Gateway"), hint: "--gateway" },
          h(TextInput, {
            value: form.gateway,
            onChange: patch("gateway"),
            placeholder: "172.30.0.1",
          }),
        ),
        h(
          "div",
          { className: "col-span-2 flex flex-wrap items-center gap-3" },
          h(Checkbox, { checked: form.internal, onChange: patch("internal"), label: "--internal" }),
          h(Checkbox, { checked: form.ipv6, onChange: patch("ipv6"), label: "--ipv6" }),
          h(Checkbox, {
            checked: form.attachable,
            onChange: patch("attachable"),
            label: "--attachable",
          }),
        ),
      ),
    );
  };

  const ConnectModal = ({ c }) => {
    const { network } = c.modal;
    const candidates = c.allContainers;
    const [reference, setReference] = useState(candidates[0] ? candidates[0].id : "");
    const [alias, setAlias] = useState("");
    const submit = () => {
      if (!reference) {
        return;
      }
      const container = candidates.find((entry) => entry.id === reference);
      c.closeModal();
      c.task(
        `connect:${network}`,
        `docker network connect ${network} ${container ? container.name : reference}`,
        () => c.client.connectNetwork(network, reference, { alias: alias.trim() || undefined }),
      );
    };
    return h(
      Modal,
      {
        title: t("Connect a container"),
        description: `docker network connect ${network} …`,
        onClose: c.closeModal,
        actions: formActions(c, t("Connect"), submit, !reference),
      },
      candidates.length === 0
        ? h("p", { className: "text-[11px] text-muted" }, t("No containers on this host."))
        : h(
            "div",
            { className: "grid grid-cols-2 gap-3" },
            h(
              Field,
              { label: t("Container") },
              h(Select, {
                value: reference,
                onChange: setReference,
                options: candidates.map((container) => ({
                  value: container.id,
                  label: `${container.name} (${container.state})`,
                })),
              }),
            ),
            h(
              Field,
              { label: t("Alias"), hint: "--alias" },
              h(TextInput, { value: alias, onChange: setAlias }),
            ),
          ),
    );
  };

  return {
    ConnectModal,
    CreateNetworkModal,
    CreateVolumeModal,
    PullModal,
    RenameModal,
    TagModal,
  };
}
