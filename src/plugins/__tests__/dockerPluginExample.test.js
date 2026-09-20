import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { activate } from "../../../examples/docker-plugin/index.js";
import manifest from "../../../examples/docker-plugin/manifest.json";
import {
  classifyDockerFailure,
  containerLogsCommand,
  containersCommand,
  createDockerClient,
  describeDockerFailure,
  dockerActionCommand,
  imagesCommand,
  inspectCommand,
  isSafeId,
  isSafeImageId,
  isSafeImageRef,
  parseContainers,
  parseImages,
  parseInspect,
  parseSystemDf,
  pruneImagesCommand,
  pullCommand,
  removeImageCommand,
  systemDfCommand,
} from "../../../examples/docker-plugin/docker.js";

const PS_OUTPUT = [
  "a1b2c3d4e5f6\tweb\tnginx:1.27\trunning\tUp 3 hours\t0.0.0.0:8080->80/tcp",
  "0f1e2d3c4b5a\tapi,api-alias\tnode:22\tpaused\tUp 2 hours (Paused)\t",
  "deadbeef0001\tworker\tredis:7\texited\tExited (0) 5 minutes ago\t",
].join("\n");

const IMAGES_OUTPUT = [
  "sha256:1111\tnginx\t1.27\t187MB\t2 weeks ago",
  "sha256:2222\tnode\t22\t1.1GB\t3 days ago",
  "sha256:3333\t<none>\t<none>\t90MB\t5 weeks ago",
].join("\n");

describe("docker plugin command builders", () => {
  it("asks docker for tab-separated fields", () => {
    expect(containersCommand()).toContain("docker ps -a --format");
    expect(containersCommand()).toContain("{{.Names}}");
    expect(imagesCommand()).toContain("docker images --format");
  });

  it("only builds actions for real hex ids", () => {
    expect(dockerActionCommand("stop", "a1b2c3d4e5f6")).toBe("docker stop a1b2c3d4e5f6");
    expect(dockerActionCommand("rm", "deadbeef0001")).toBe("docker rm deadbeef0001");
    expect(containerLogsCommand("a1b2c3d4e5f6", 100)).toBe("docker logs --tail 100 a1b2c3d4e5f6");
  });

  it("refuses ids that could carry shell syntax", () => {
    for (const bad of ["a1b2; rm -rf /", "$(whoami)", "a1b2c3 && curl x", "", null, "zzzzzz"]) {
      expect(isSafeId(bad)).toBe(false);
      expect(() => dockerActionCommand("stop", bad)).toThrow();
      expect(() => containerLogsCommand(bad)).toThrow();
    }
  });

  it("refuses an action outside the allowlist", () => {
    expect(() => dockerActionCommand("exec", "a1b2c3d4e5f6")).toThrow(/unsupported/);
  });

  it("builds the inspect, pull and image-removal commands", () => {
    expect(inspectCommand("a1b2c3d4e5f6")).toBe("docker inspect a1b2c3d4e5f6");
    expect(pullCommand("nginx:1.27")).toBe("docker pull nginx:1.27");
    expect(pullCommand("ghcr.io/org/app@sha256:abc123")).toBe(
      "docker pull ghcr.io/org/app@sha256:abc123",
    );
    expect(removeImageCommand("sha256:111111111111")).toBe("docker rmi sha256:111111111111");
    expect(removeImageCommand("111111111111")).toBe("docker rmi 111111111111");
    expect(systemDfCommand()).toContain("docker system df");
    expect(pruneImagesCommand()).toBe("docker image prune -f");
  });

  it("refuses an image reference that could carry shell syntax", () => {
    for (const bad of [
      "nginx; rm -rf /",
      "$(whoami)",
      "nginx && curl x",
      "nginx`id`",
      "-rm",           // a leading dash would read as a flag
      "nginx:1.27 | tee /etc/passwd",
      "",
      null,
    ]) {
      expect(isSafeImageRef(bad)).toBe(false);
      expect(() => pullCommand(bad)).toThrow();
    }
    // Registry hosts, paths, tags and digests all stay legal.
    for (const good of ["nginx", "nginx:1.27", "ghcr.io/org/app:v1", "app@sha256:abc123"]) {
      expect(isSafeImageRef(good)).toBe(true);
    }
  });

  it("accepts both image id shapes and refuses anything else", () => {
    expect(isSafeImageId("sha256:111111111111")).toBe(true);
    expect(isSafeImageId("111111111111")).toBe(true);
    expect(isSafeImageId("sha256:zz")).toBe(false);
    expect(isSafeImageId("1111; rm -rf /")).toBe(false);
    expect(() => removeImageCommand("1111; rm -rf /")).toThrow();
  });
});

describe("docker plugin parsers", () => {
  it("parses container rows and tolerates a missing trailing field", () => {
    const rows = parseContainers(PS_OUTPUT);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: "a1b2c3d4e5f6",
      name: "web",
      image: "nginx:1.27",
      state: "running",
      running: true,
      ports: "0.0.0.0:8080->80/tcp",
    });
    // `.Names` is comma-separated; the first name wins.
    expect(rows[1].name).toBe("api");
    expect(rows[1].running).toBe(false);
    // Docker omits a trailing empty field rather than emitting a bare tab.
    expect(rows[2].ports).toBe("");
    expect(rows[2].state).toBe("exited");
  });

  it("ignores blank lines and CRLF endings", () => {
    expect(parseContainers("\r\n\r\n")).toEqual([]);
    expect(parseContainers("")).toEqual([]);
  });

  it("parses image rows and labels untagged images", () => {
    const rows = parseImages(IMAGES_OUTPUT);
    expect(rows[0].reference).toBe("nginx:1.27");
    expect(rows[2].reference).toBe("<none>");
    expect(rows[2].size).toBe("90MB");
  });

  it("marks a paused container as not running", () => {
    const rows = parseContainers(PS_OUTPUT);
    expect(rows[1].state).toBe("paused");
    expect(rows[1].paused).toBe(true);
    expect(rows[1].running).toBe(false);
  });

  it("parses docker system df rows", () => {
    const rows = parseSystemDf(
      ["Images\t12\t3.1GB\t1.2GB (38%)", "Containers\t4\t20MB\t0B (0%)"].join("\n"),
    );
    expect(rows[0]).toEqual({
      type: "Images",
      count: "12",
      size: "3.1GB",
      reclaimable: "1.2GB (38%)",
    });
    expect(rows[1].type).toBe("Containers");
  });

  it("summarises docker inspect output", () => {
    const summary = parseInspect(
      JSON.stringify([
        {
          Id: "a1b2c3d4e5f6aa",
          Name: "/web",
          Created: "2026-01-01T00:00:00Z",
          Path: "nginx",
          Args: ["-g", "daemon off;"],
          State: { Status: "running", StartedAt: "2026-01-01T00:00:01Z", ExitCode: 0 },
          HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
          Config: { Image: "nginx:1.27", Env: ["PATH=/usr/bin"] },
          NetworkSettings: {
            Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
            Networks: { bridge: {} },
          },
          Mounts: [{ Source: "/srv/www", Destination: "/usr/share/nginx/html", RW: false }],
        },
      ]),
    );
    expect(summary.name).toBe("web");
    expect(summary.image).toBe("nginx:1.27");
    expect(summary.command).toBe("nginx -g daemon off;");
    expect(summary.ports).toEqual(["0.0.0.0:8080->80/tcp"]);
    expect(summary.mounts).toEqual(["/srv/www → /usr/share/nginx/html (ro)"]);
    expect(summary.networks).toEqual(["bridge"]);
    expect(summary.restartPolicy).toBe("unless-stopped");
  });

  it("returns null for inspect output it cannot parse", () => {
    expect(parseInspect("not json")).toBeNull();
    expect(parseInspect("[]")).toBeNull();
    expect(parseInspect("null")).toBeNull();
  });

  it("classifies the failures a user can act on", () => {
    expect(classifyDockerFailure({ stderr: "bash: docker: command not found", exitCode: 127 }))
      .toMatchObject({ kind: "missing" });
    expect(classifyDockerFailure({ stderr: "permission denied while trying to connect", exitCode: 1 }))
      .toMatchObject({ kind: "permission" });
    expect(classifyDockerFailure({ stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", exitCode: 1 }))
      .toMatchObject({ kind: "daemon" });
    expect(classifyDockerFailure({ stderr: "some other failure", exitCode: 1 }))
      .toEqual({ kind: "error", detail: "some other failure", message: "some other failure" });
  });

  it("words each failure for the panel and keeps the raw stderr", () => {
    const permission = classifyDockerFailure({
      stderr:
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      exitCode: 1,
    });
    expect(permission.kind).toBe("permission");
    expect(permission.detail).toContain("unix:///var/run/docker.sock");

    const described = describeDockerFailure(permission);
    expect(described.text).toMatch(/Docker socket/);
    // The fix must name the reconnect: the group list is read at login, so
    // an existing session keeps the old one.
    expect(described.hint).toContain("usermod -aG docker");
    expect(described.hint).toMatch(/reconnect/);
  });

  it("gives an actionable hint for each failure kind", () => {
    expect(describeDockerFailure({ kind: "missing" }).hint).toMatch(/PATH/);
    expect(describeDockerFailure({ kind: "daemon" }).hint).toMatch(/systemctl start docker/);
    expect(describeDockerFailure({ kind: "error", message: "boom", detail: "raw" })).toEqual({
      text: "boom",
      hint: "raw",
    });
    expect(describeDockerFailure(null).text).toMatch(/failed/);
  });
});

// Mirrors the host contract the loader provides: a controller hook, panels
// rendered with `{ api, context, controller }`, and a facade whose
// `sessions.execute` is the only backend the plugin may reach.
function fixture({ execute } = {}) {
  const panels = [];
  const toolbars = [];
  const disposers = [];
  let controller;
  const register = (accept) =>
    vi.fn((item) => {
      accept(item);
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    });
  const executeMock =
    execute ||
    vi.fn(async (sessionId, command) => {
      if (command.startsWith("docker ps")) {
        return { stdout: PS_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.startsWith("docker images")) {
        return { stdout: IMAGES_OUTPUT, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
  const api = {
    react: React,
    meta: { pluginId: manifest.id, apiVersion: 1 },
    sessions: { execute: executeMock },
    storage: { get: () => undefined, set: () => {}, remove: () => {} },
    ui: {
      registerPanel: register((panel) => panels.push(panel)),
      registerToolbar: register((toolbar) => toolbars.push(toolbar)),
      registerController: register((hook) => {
        controller = hook;
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const DEFAULT_CONTEXT = { activeSessionId: "s1", activeSession: { configName: "prod-1" } };
  return {
    api,
    panels,
    toolbars,
    disposers,
    execute: executeMock,
    // The panel renders from an explicit controller snapshot. This suite has
    // no DOM, so effects never fire and a mounted controller could not
    // advance past its initial state; the async paths are covered against
    // `createDockerClient` instead, and these renders assert the static
    // states (no session, failure, empty, populated).
    render(context = DEFAULT_CONTEXT, controller = {}) {
      const state = {
        tab: "containers",
        containers: [],
        images: [],
        diskRows: [],
        loading: false,
        failure: null,
        busyId: null,
        notice: null,
        logs: null,
        inspect: null,
        pullRef: "",
        tail: 200,
        follow: false,
        hostLabel: context.activeSession?.configName || context.activeSessionId || "",
        hasSession: Boolean(context.activeSessionId),
        ...controller,
      };
      return renderToStaticMarkup(panels.at(-1).render({ api, context, controller: state }));
    },
  };
}

// The data layer the controller delegates to, driven with a fake session.
function clientFixture(execute) {
  return createDockerClient(execute);
}

const okExecute = vi.fn(async (command) => {
  if (command.startsWith("docker ps")) {
    return { stdout: PS_OUTPUT, stderr: "", exitCode: 0 };
  }
  if (command.startsWith("docker images")) {
    return { stdout: IMAGES_OUTPUT, stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
});

describe("docker plugin client", () => {
  it("lists containers and images in one round trip", async () => {
    const client = clientFixture(okExecute);
    const result = await client.list();
    expect(result.failure).toBeNull();
    expect(result.containers).toHaveLength(3);
    expect(result.images).toHaveLength(3);
    expect(result.containers[0].name).toBe("web");
    expect(result.images[0].reference).toBe("nginx:1.27");
  });

  it("reports a host-level failure from docker ps", async () => {
    const client = clientFixture(
      vi.fn(async () => ({ stdout: "", stderr: "Cannot connect to the Docker daemon", exitCode: 1 })),
    );
    const result = await client.list();
    expect(result.failure).toMatchObject({ kind: "daemon" });
    expect(result.failure.detail).toContain("Cannot connect to the Docker daemon");
    expect(result.containers).toEqual([]);
  });

  it("keeps the container list when only docker images fails", async () => {
    const client = clientFixture(
      vi.fn(async (command) =>
        command.startsWith("docker images")
          ? { stdout: "", stderr: "no permission", exitCode: 1 }
          : { stdout: PS_OUTPUT, stderr: "", exitCode: 0 },
      ),
    );
    const result = await client.list();
    expect(result.failure).toBeNull();
    expect(result.containers).toHaveLength(3);
    expect(result.images).toEqual([]);
  });

  it("reports an action failure instead of claiming success", async () => {
    const client = clientFixture(
      vi.fn(async () => ({ stdout: "", stderr: "No such container", exitCode: 1 })),
    );
    const result = await client.action("stop", "a1b2c3d4e5f6");
    expect(result.ok).toBe(false);
    expect(result.failure.message).toBe("No such container");
  });

  it("returns logs, and a placeholder when docker prints nothing", async () => {
    const withOutput = clientFixture(
      vi.fn(async () => ({ stdout: "listening on :80\n", stderr: "", exitCode: 0 })),
    );
    expect(await withOutput.logs("a1b2c3d4e5f6", 200)).toBe("listening on :80");

    const silent = clientFixture(vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })));
    expect(await silent.logs("a1b2c3d4e5f6", 200)).toBe("(no output)");
  });

  it("reads disk usage", async () => {
    const client = clientFixture(
      vi.fn(async () => ({
        stdout: "Images\t12\t3.1GB\t1.2GB (38%)",
        stderr: "",
        exitCode: 0,
      })),
    );
    const result = await client.diskUsage();
    expect(result.failure).toBeNull();
    expect(result.rows[0].type).toBe("Images");
  });

  it("reports a disk-usage failure without throwing", async () => {
    const client = clientFixture(
      vi.fn(async () => ({ stdout: "", stderr: "Cannot connect to the Docker daemon", exitCode: 1 })),
    );
    const result = await client.diskUsage();
    expect(result.rows).toEqual([]);
    expect(result.failure.kind).toBe("daemon");
  });

  it("returns both the inspect summary and the raw JSON", async () => {
    const payload = JSON.stringify([{ Id: "a1b2c3d4e5f6", Name: "/web", State: { Status: "running" } }]);
    const client = clientFixture(vi.fn(async () => ({ stdout: payload, stderr: "", exitCode: 0 })));
    const result = await client.inspect("a1b2c3d4e5f6");
    expect(result.summary.name).toBe("web");
    expect(result.raw).toBe(payload);
    expect(result.failure).toBeNull();
  });

  it("keeps the raw text when inspect output is unparseable", async () => {
    const client = clientFixture(
      vi.fn(async () => ({ stdout: "garbage", stderr: "", exitCode: 0 })),
    );
    const result = await client.inspect("a1b2c3d4e5f6");
    expect(result.summary).toBeNull();
    expect(result.raw).toBe("garbage");
  });

  it("reports pull, remove and prune outcomes", async () => {
    const ok = clientFixture(vi.fn(async () => ({ stdout: "Pulled", stderr: "", exitCode: 0 })));
    expect(await ok.pull("nginx:1.27")).toEqual({ ok: true, output: "Pulled" });
    expect(await ok.removeImage("sha256:111111111111")).toEqual({ ok: true, output: "Pulled" });
    expect(await ok.pruneImages()).toEqual({ ok: true, output: "Pulled" });

    const bad = clientFixture(
      vi.fn(async () => ({ stdout: "", stderr: "manifest unknown", exitCode: 1 })),
    );
    const pulled = await bad.pull("nginx:nope");
    expect(pulled.ok).toBe(false);
    expect(pulled.failure.message).toBe("manifest unknown");
  });

  it("refuses to build a command for a hostile reference", async () => {
    const client = clientFixture(vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })));
    await expect(client.pull("nginx; rm -rf /")).rejects.toThrow(/unexpected image reference/);
    await expect(client.removeImage("1111; rm -rf /")).rejects.toThrow(/unexpected image id/);
    await expect(client.inspect("$(whoami)")).rejects.toThrow(/unexpected id/);
  });
});

describe("docker plugin activation", () => {
  it("registers a panel, a toolbar button and one controller", async () => {
    const host = fixture();
    const dispose = await activate(host.api);
    expect(manifest.builtin).toBe(false);
    expect(manifest.apiVersion).toBe(1);
    expect(host.panels[0].id).toBe(manifest.contributes.panels[0].id);
    expect(host.toolbars[0].panelId).toBe(host.panels[0].id);
    // The icon is the plugin's own asset, resolved against its module URL.
    // Under vitest that is a `file:` URL; at runtime the host serves the
    // module over `plugin://`, so the same expression yields that origin.
    expect(host.toolbars[0].icon).toMatch(/icon\.svg$/);
    dispose();
    for (const unregister of host.disposers) expect(unregister).toHaveBeenCalledOnce();
  });

  it("renders the container list it was handed", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(
      { activeSessionId: "s1", activeSession: { configName: "prod-1" } },
      { containers: parseContainers(PS_OUTPUT), images: parseImages(IMAGES_OUTPUT) },
    );
    expect(html).toContain("Docker");
    expect(html).toContain("on prod-1");
    expect(html).toContain("Containers 3");
    expect(html).toContain("web");
    expect(html).toContain("nginx:1.27");
    // A running container offers Stop; an exited one offers Start and Remove.
    expect(html).toContain("Stop");
    expect(html).toContain("Remove");
  });

  it("asks for a session instead of running docker without one", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ activeSessionId: null, activeSession: null });
    expect(html).toContain("Open an SSH session");
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("explains a host without docker instead of showing a raw error", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, { failure: { kind: "missing" } });
    expect(html).toContain("docker was not found on the remote host");
  });

  it("shows the fix and the raw stderr for a socket permission failure", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, {
      failure: {
        kind: "permission",
        detail: "permission denied while trying to connect to the Docker daemon socket",
      },
    });
    expect(html).toContain("cannot reach the Docker socket");
    expect(html).toContain("usermod -aG docker");
    expect(html).toContain("permission denied while trying to connect");
  });

  it("shows an empty state rather than a blank panel", async () => {
    const host = fixture();
    await activate(host.api);
    expect(host.render()).toContain("No containers on this host.");
    expect(host.render(undefined, { tab: "images" })).toContain("No images on this host.");
  });

  it("renders the log overlay for the selected container", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, {
      logs: { id: "a1b2c3d4e5f6", name: "web", text: "listening on :80" },
    });
    expect(html).toContain("logs · web");
    expect(html).toContain("listening on :80");
    // The tail selector and the follow toggle live in the overlay header.
    expect(html).toContain("last 200");
    expect(html).toContain("follow");
    expect(html).toContain("Reload");
  });

  it("offers Pause on a running container and Unpause on a paused one", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, { containers: parseContainers(PS_OUTPUT) });
    // Row 0 runs, row 1 is paused, row 2 exited.
    expect(html).toContain("Pause");
    expect(html).toContain("Unpause");
    expect(html).toContain("Inspect");
    // Remove is offered only where `docker rm` can succeed.
    expect(html.match(/>Remove</g)).toHaveLength(1);
  });

  it("renders the images tab with a pull field and prune", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, {
      tab: "images",
      images: parseImages(IMAGES_OUTPUT),
    });
    expect(html).toContain("nginx:1.27");
    expect(html).toContain("Pull");
    expect(html).toContain("Prune unused");
    expect(html).toContain("placeholder=\"nginx:1.27\"");
  });

  it("renders the disk tab", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, {
      tab: "disk",
      diskRows: parseSystemDf("Images\t12\t3.1GB\t1.2GB (38%)"),
    });
    expect(html).toContain("Reclaimable");
    expect(html).toContain("3.1GB");
  });

  it("renders the inspect overlay with the summary and the raw JSON", async () => {
    const host = fixture();
    await activate(host.api);
    const raw = JSON.stringify([
      {
        Id: "a1b2c3d4e5f6aa",
        Name: "/web",
        Path: "nginx",
        State: { Status: "running", ExitCode: 0 },
        Config: { Image: "nginx:1.27" },
        NetworkSettings: { Ports: {}, Networks: { bridge: {} } },
        Mounts: [],
      },
    ]);
    const html = host.render(undefined, {
      inspect: { id: "a1b2c3d4e5f6", name: "web", summary: parseInspect(raw), raw },
    });
    expect(html).toContain("inspect · web");
    expect(html).toContain("nginx:1.27");
    expect(html).toContain("bridge");
    expect(html).toContain("Raw JSON");
  });

  it("shows a notice above the list", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render(undefined, {
      notice: { tone: "success", text: "stop web" },
    });
    expect(html).toContain("stop web");
  });
});
