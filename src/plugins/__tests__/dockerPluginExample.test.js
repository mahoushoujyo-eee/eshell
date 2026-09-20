import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { activate } from "../../../examples/docker-plugin/index.js";
import manifest from "../../../examples/docker-plugin/manifest.json";
import {
  classifyDockerFailure,
  composeActionCommand,
  composeLogsCommand,
  containerActionCommand,
  containerExecCommand,
  containerLogsCommand,
  containersCommand,
  createDockerClient,
  describeDockerFailure,
  deriveState,
  eventsCommand,
  imagesCommand,
  isSafeId,
  isSafeImageId,
  isSafeImageRef,
  networkCreateCommand,
  parseComposeProjects,
  parseContainers,
  parseEvents,
  parseImages,
  parseInfo,
  parseInspect,
  parseJsonRows,
  parseLabels,
  parseNetworks,
  parseStats,
  parseSystemDf,
  parseVolumes,
  pruneImagesCommand,
  pullCommand,
  removeImageCommand,
  runCommand,
  sanitizeBin,
  searchCommand,
  shellQuote,
  systemDfCommand,
  tagCommand,
  tokenizeArgs,
  volumeCreateCommand,
} from "../../../examples/docker-plugin/docker.js";

// `docker ps --format '{{json .}}'` output: one JSON object per line.
const PS_OUTPUT = [
  JSON.stringify({
    ID: "a1b2c3d4e5f6000000000000000000000000000000000000000000000000aaaa",
    Names: "web",
    Image: "nginx:1.27",
    State: "running",
    Status: "Up 3 hours",
    Ports: "0.0.0.0:8080->80/tcp",
    CreatedAt: "2026-01-01 10:00:00 +0000 UTC",
    RunningFor: "3 hours ago",
    Size: "0B",
    Command: '"/docker-entrypoint.sh nginx"',
    Mounts: "srv_data",
    Networks: "shop_default",
    Labels:
      "com.docker.compose.project=shop,com.docker.compose.service=web,com.docker.compose.project.config_files=/srv/shop/docker-compose.yml",
  }),
  JSON.stringify({
    ID: "0f1e2d3c4b5a",
    Names: "api,api-alias",
    Image: "node:22",
    Status: "Up 2 hours (Paused)",
    Ports: "",
    Labels: "",
  }),
  JSON.stringify({
    ID: "deadbeef0001",
    Names: "worker",
    Image: "redis:7",
    State: "exited",
    Status: "Exited (0) 5 minutes ago",
    Labels: "",
  }),
].join("\n");

const IMAGES_OUTPUT = [
  JSON.stringify({
    ID: "sha256:1111111111111111",
    Repository: "nginx",
    Tag: "1.27",
    Digest: "sha256:abcd",
    Size: "187MB",
    CreatedSince: "2 weeks ago",
    CreatedAt: "2025-12-01 00:00:00",
  }),
  JSON.stringify({
    ID: "sha256:3333333333333333",
    Repository: "<none>",
    Tag: "<none>",
    Digest: "<none>",
    Size: "90MB",
    CreatedSince: "5 weeks ago",
  }),
].join("\n");

describe("docker command builders", () => {
  it("asks docker for machine-readable JSON rows", () => {
    expect(containersCommand()).toBe("docker ps -a --no-trunc --format '{{json .}}'");
    expect(imagesCommand()).toContain("docker images --no-trunc --digests");
    expect(imagesCommand({ all: true, dangling: true })).toContain("-a --filter dangling=true");
    expect(systemDfCommand()).toBe("docker system df --format '{{json .}}'");
    expect(pruneImagesCommand()).toBe("docker image prune -f");
    expect(pruneImagesCommand({ all: true })).toBe("docker image prune -f -a");
  });

  it("honours a sanitised CLI prefix and falls back for anything else", () => {
    expect(sanitizeBin("sudo -n docker")).toBe("sudo -n docker");
    expect(sanitizeBin("/usr/bin/docker")).toBe("/usr/bin/docker");
    expect(sanitizeBin("podman")).toBe("podman");
    expect(sanitizeBin("")).toBe("docker");
    // A prefix that could carry shell syntax is replaced, not quoted.
    for (const bad of ["docker; rm -rf /", "$(id)", "docker && curl x", "docker|tee", "`id`"]) {
      expect(sanitizeBin(bad)).toBe("docker");
    }
    expect(containersCommand({ bin: "sudo -n docker" })).toMatch(/^sudo -n docker ps/);
    expect(containersCommand({ bin: "docker; rm -rf /" })).toMatch(/^docker ps/);
  });

  it("builds lifecycle actions only for references docker itself printed", () => {
    expect(containerActionCommand("stop", "a1b2c3d4e5f6")).toBe("docker stop a1b2c3d4e5f6");
    expect(containerActionCommand("stop", "web", { timeout: 30 })).toBe("docker stop -t 30 web");
    expect(containerActionCommand("kill", "web", { signal: "sigterm" })).toBe(
      "docker kill -s SIGTERM web",
    );
    expect(containerActionCommand("rm", "web", { force: true, volumes: true })).toBe(
      "docker rm -f -v web",
    );
    expect(() => containerActionCommand("exec", "web")).toThrow(/unsupported/);
    expect(() => containerActionCommand("kill", "web", { signal: "9; rm -rf /" })).toThrow(
      /unexpected signal/,
    );
  });

  it("refuses references that could carry shell syntax", () => {
    for (const bad of ["a1b2; rm -rf /", "$(whoami)", "a1b2c3 && curl x", "", null, "-rm", "a b"]) {
      expect(isSafeId(bad)).toBe(false);
      expect(() => containerActionCommand("stop", bad)).toThrow();
      expect(() => containerLogsCommand(bad)).toThrow();
    }
    // A container name docker would accept stays legal.
    expect(containerActionCommand("start", "shop-web-1")).toBe("docker start shop-web-1");
  });

  it("folds stderr into stdout for logs so the order survives", () => {
    expect(containerLogsCommand("web", { tail: 100 })).toBe("docker logs --tail 100 web 2>&1");
    expect(containerLogsCommand("web", { tail: 50, timestamps: true, since: "10m" })).toBe(
      "docker logs --tail 50 --since 10m -t web 2>&1",
    );
    expect(() => containerLogsCommand("web", { since: "$(date)" })).toThrow(/--since/);
  });

  it("runs exec either through sh -c or as argv, never as raw text", () => {
    expect(containerExecCommand("web", "ls -al /tmp | head", { shell: true })).toBe(
      "docker exec web sh -c 'ls -al /tmp | head' 2>&1",
    );
    expect(containerExecCommand("web", "ls -al /tmp")).toBe(
      "docker exec web 'ls' '-al' '/tmp' 2>&1",
    );
    // A quoted argument stays one token.
    expect(containerExecCommand("web", `sh -c 'echo hi'`)).toBe(
      "docker exec web 'sh' '-c' 'echo hi' 2>&1",
    );
    expect(containerExecCommand("web", "whoami", { user: "root", workdir: "/app" })).toBe(
      "docker exec -u root -w '/app' web 'whoami' 2>&1",
    );
    expect(() => containerExecCommand("web", "echo 'unbalanced")).toThrow(/unbalanced quote/);
    expect(() => containerExecCommand("web", "")).toThrow(/required/);
    expect(() => containerExecCommand("web", "id", { user: "root; rm -rf /" })).toThrow(/--user/);
  });

  it("tokenises a command line the way a shell would", () => {
    expect(tokenizeArgs("nginx -g 'daemon off;'")).toEqual(["nginx", "-g", "daemon off;"]);
    expect(tokenizeArgs('sh -c "echo $HOME"')).toEqual(["sh", "-c", "echo $HOME"]);
    expect(tokenizeArgs("   ")).toEqual([]);
    expect(() => tokenizeArgs("'oops")).toThrow(/unbalanced/);
  });

  it("single-quotes values that legitimately contain spaces", () => {
    expect(shellQuote("/srv/my data")).toBe("'/srv/my data'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds docker run from validated fields", () => {
    expect(
      runCommand({
        image: "nginx:1.27",
        name: "web",
        ports: ["8080:80", "127.0.0.1:5432:5432/tcp"],
        env: ["TZ=Asia/Shanghai", "MSG=hello world"],
        volumes: ["/srv/my data:/data:ro"],
        restart: "unless-stopped",
        command: "nginx -g 'daemon off;'",
      }),
    ).toBe(
      "docker run -d --name web --restart=unless-stopped -p 8080:80 -p 127.0.0.1:5432:5432/tcp " +
        "-e TZ='Asia/Shanghai' -e MSG='hello world' -v '/srv/my data':'/data':ro nginx:1.27 " +
        "'nginx' '-g' 'daemon off;'",
    );
  });

  it("rejects every hostile field in the run form", () => {
    expect(() => runCommand({ image: "nginx; rm -rf /" })).toThrow(/unexpected reference/);
    expect(() => runCommand({ image: "nginx", ports: ["8080:80; id"] })).toThrow(/publish spec/);
    expect(() => runCommand({ image: "nginx", env: ["BAD KEY=1"] })).toThrow(/variable name/);
    expect(() => runCommand({ image: "nginx", volumes: ["/a"] })).toThrow(/source:target/);
    expect(() => runCommand({ image: "nginx", volumes: ["/a:b"] })).toThrow(/absolute path/);
    expect(() => runCommand({ image: "nginx", restart: "always; id" })).toThrow(/restart policy/);
    expect(() => runCommand({ image: "nginx", cpus: "1 && id" })).toThrow(/--cpus/);
    expect(() => runCommand({ image: "nginx", memory: "512m; id" })).toThrow(/--memory/);
    // docker itself refuses this pair, so the builder does too.
    expect(() => runCommand({ image: "nginx", autoRemove: true, restart: "always" })).toThrow(
      /--rm cannot be combined/,
    );
  });

  it("builds image, volume and network commands", () => {
    expect(pullCommand("ghcr.io/org/app@sha256:abc123")).toBe(
      "docker pull ghcr.io/org/app@sha256:abc123",
    );
    expect(pullCommand("nginx", { platform: "linux/arm64" })).toBe(
      "docker pull --platform=linux/arm64 nginx",
    );
    expect(tagCommand("sha256:111111111111", "registry.example.com/team/app:v2")).toBe(
      "docker tag sha256:111111111111 registry.example.com/team/app:v2",
    );
    expect(removeImageCommand("nginx:1.27", { force: true })).toBe("docker rmi -f nginx:1.27");
    expect(volumeCreateCommand("data", { driver: "local" })).toBe(
      "docker volume create -d local data",
    );
    expect(networkCreateCommand("proxy", { driver: "bridge", subnet: "172.30.0.0/16" })).toBe(
      "docker network create -d bridge --subnet=172.30.0.0/16 proxy",
    );
    expect(searchCommand("nginx", { limit: 10 })).toBe(
      "docker search --limit 10 --format '{{json .}}' nginx",
    );
    expect(() => pullCommand("nginx; rm -rf /")).toThrow(/unexpected image reference/);
    expect(() => pullCommand("-rm")).toThrow();
    expect(() => searchCommand("nginx; id")).toThrow(/unexpected term/);
    expect(() => networkCreateCommand("proxy", { subnet: "1.2.3.4/16; id" })).toThrow(/--subnet/);
  });

  it("quotes compose file paths and refuses verbs that need one without it", () => {
    expect(
      composeActionCommand("up", {
        project: "shop",
        files: ["/srv/a b/docker-compose.yml"],
        workingDir: "/srv/a b",
      }),
    ).toBe(
      "docker compose -p shop -f '/srv/a b/docker-compose.yml' --project-directory '/srv/a b' up -d",
    );
    expect(composeActionCommand("restart", { project: "shop" })).toBe(
      "docker compose -p shop restart",
    );
    expect(composeActionCommand("down", { project: "shop", files: ["/a.yml"], volumes: true })).toBe(
      "docker compose -p shop -f '/a.yml' down -v",
    );
    expect(composeLogsCommand({ project: "shop" }, { tail: 50 })).toBe(
      "docker compose -p shop logs --no-color --tail=50 2>&1",
    );
    expect(() => composeActionCommand("up", { project: "shop", files: [] })).toThrow(
      /needs the project's compose file/,
    );
    expect(() => composeActionCommand("exec", { project: "shop" })).toThrow(/unsupported/);
  });

  it("bounds docker events so the command returns", () => {
    expect(eventsCommand({ since: "30m" })).toBe(
      "docker events --since 30m --until 0s --format '{{json .}}'",
    );
    expect(() => eventsCommand({ since: "30m; id" })).toThrow(/--since/);
  });

  it("accepts both image id shapes and refuses anything else", () => {
    expect(isSafeImageId("sha256:111111111111")).toBe(true);
    expect(isSafeImageId("111111111111")).toBe(true);
    expect(isSafeImageId("sha256:zz")).toBe(false);
    expect(isSafeImageRef("ghcr.io/org/app:v1")).toBe(true);
    expect(isSafeImageRef("nginx:1.27 | tee /etc/passwd")).toBe(false);
  });
});

describe("docker output parsers", () => {
  it("reads NDJSON and a JSON array with the same parser", () => {
    expect(parseJsonRows('{"a":1}\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonRows('[{"a":1}]')).toEqual([{ a: 1 }]);
    // A malformed record is skipped, not fatal: one bad line must not blank a tab.
    expect(parseJsonRows('{"a":1}\nnot json\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonRows("")).toEqual([]);
  });

  it("parses containers, including compose labels and derived state", () => {
    const rows = parseContainers(PS_OUTPUT);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      name: "web",
      image: "nginx:1.27",
      state: "running",
      running: true,
      ports: "0.0.0.0:8080->80/tcp",
      composeProject: "shop",
      composeService: "web",
      removable: false,
    });
    expect(rows[0].shortId).toBe("a1b2c3d4e5f6");
    expect(rows[0].composeFiles).toEqual(["/srv/shop/docker-compose.yml"]);
    // `.Names` is comma-separated when a container carries several names.
    expect(rows[1].name).toBe("api");
    // No `.State` field (docker < 20.10): recovered from the status text.
    expect(rows[1].state).toBe("paused");
    expect(rows[1].paused).toBe(true);
    expect(rows[1].running).toBe(false);
    expect(rows[2].state).toBe("exited");
    expect(rows[2].removable).toBe(true);
  });

  it("recovers a state from every status phrasing docker prints", () => {
    expect(deriveState("", "Up 2 hours")).toBe("running");
    expect(deriveState("", "Up 2 hours (Paused)")).toBe("paused");
    expect(deriveState("", "Exited (137) 1 minute ago")).toBe("exited");
    expect(deriveState("", "Created")).toBe("created");
    expect(deriveState("", "Restarting (1) 3 seconds ago")).toBe("restarting");
    expect(deriveState("", "")).toBe("unknown");
    // An explicit state always wins.
    expect(deriveState("dead", "Up 2 hours")).toBe("dead");
  });

  it("parses labels into a map", () => {
    expect(parseLabels("a=b,c=d")).toEqual({ a: "b", c: "d" });
    expect(parseLabels("")).toEqual({});
    expect(parseLabels("flag")).toEqual({ flag: "" });
  });

  it("parses images and flags dangling layers", () => {
    const rows = parseImages(IMAGES_OUTPUT);
    expect(rows[0]).toMatchObject({ reference: "nginx:1.27", size: "187MB", dangling: false });
    expect(rows[0].shortId).toBe("111111111111");
    expect(rows[1]).toMatchObject({ reference: "<none>", dangling: true });
  });

  it("parses volumes, networks, stats, disk usage and events", () => {
    expect(
      parseVolumes(
        JSON.stringify({ Name: "data", Driver: "local", Scope: "local", Mountpoint: "/v/data", Size: "N/A" }),
      )[0],
    ).toEqual({ name: "data", driver: "local", scope: "local", mountpoint: "/v/data", labels: {}, size: "" });

    const networks = parseNetworks(
      [
        JSON.stringify({ ID: "aaa", Name: "bridge", Driver: "bridge", Scope: "local", Internal: "false" }),
        JSON.stringify({ ID: "bbb", Name: "shop_default", Driver: "bridge", Internal: "true" }),
      ].join("\n"),
    );
    expect(networks[0].predefined).toBe(true);
    expect(networks[1].internal).toBe(true);
    expect(networks[1].predefined).toBe(false);

    const stats = parseStats(
      JSON.stringify({ ID: "a1b2c3d4e5f6", Name: "web", CPUPerc: "12.34%", MemUsage: "20MiB / 1GiB", MemPerc: "2%", PIDs: "5" }),
    );
    expect(stats[0].cpuPercent).toBeCloseTo(12.34);
    expect(stats[0].memUsage).toBe("20MiB / 1GiB");

    expect(
      parseSystemDf(
        JSON.stringify({ Type: "Images", TotalCount: "12", Active: "3", Size: "3.1GB", Reclaimable: "1.2GB (38%)" }),
      )[0],
    ).toEqual({ type: "Images", total: "12", active: "3", size: "3.1GB", reclaimable: "1.2GB (38%)" });

    const events = parseEvents(
      JSON.stringify({
        Type: "container",
        Action: "start",
        Actor: { ID: "a1b2c3d4e5f6", Attributes: { name: "web", image: "nginx:1.27" } },
        time: 1767225600,
      }),
    );
    expect(events[0]).toMatchObject({ type: "container", action: "start", name: "web", image: "nginx:1.27" });
    expect(events[0].time).toMatch(/^20\d\d-/);
  });

  it("parses compose projects from JSON and from the table fallback", () => {
    expect(
      parseComposeProjects(
        JSON.stringify([{ Name: "shop", Status: "running(2)", ConfigFiles: "/srv/shop/compose.yml" }]),
      ),
    ).toEqual([{ name: "shop", status: "running(2)", files: ["/srv/shop/compose.yml"] }]);

    expect(
      parseComposeProjects(
        ["NAME    STATUS        CONFIG FILES", "shop    running(2)    /srv/shop/compose.yml"].join("\n"),
      ),
    ).toEqual([{ name: "shop", status: "running(2)", files: ["/srv/shop/compose.yml"] }]);
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
          RestartCount: 2,
          State: { Status: "running", StartedAt: "2026-01-01T00:00:01Z", ExitCode: 0, Health: { Status: "healthy" } },
          HostConfig: { RestartPolicy: { Name: "unless-stopped" }, LogConfig: { Type: "json-file" } },
          Config: { Image: "nginx:1.27", Env: ["PATH=/usr/bin"], WorkingDir: "/app" },
          NetworkSettings: {
            Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
            Networks: { bridge: { IPAddress: "172.17.0.2" } },
          },
          Mounts: [{ Source: "/srv/www", Destination: "/usr/share/nginx/html", RW: false }],
        },
      ]),
    );
    expect(summary).toMatchObject({
      name: "web",
      image: "nginx:1.27",
      command: "nginx -g daemon off;",
      health: "healthy",
      restartPolicy: "unless-stopped",
      logDriver: "json-file",
      workingDir: "/app",
    });
    expect(summary.ports).toEqual(["0.0.0.0:8080->80/tcp"]);
    expect(summary.mounts).toEqual(["/srv/www → /usr/share/nginx/html (ro)"]);
    expect(summary.networks).toEqual(["bridge (172.17.0.2)"]);
  });

  it("returns null for inspect output it cannot read", () => {
    expect(parseInspect("not json")).toBeNull();
    expect(parseInspect("[]")).toBeNull();
    expect(parseInspect("null")).toBeNull();
  });

  it("reads docker info", () => {
    const info = parseInfo(
      JSON.stringify({
        Name: "host-1",
        ServerVersion: "27.0.3",
        OSType: "linux",
        Architecture: "x86_64",
        NCPU: 8,
        MemTotal: 16_000_000_000,
        Containers: 5,
        ContainersRunning: 3,
        Warnings: ["No swap limit support"],
      }),
    );
    expect(info).toMatchObject({ name: "host-1", serverVersion: "27.0.3", cpus: 8, live: true });
    expect(info.warnings).toEqual(["No swap limit support"]);
    // A client-only `docker info` (daemon down) is still readable.
    expect(parseInfo(JSON.stringify({ Name: "host-1" })).live).toBe(false);
  });
});

describe("docker failure classification", () => {
  it("classifies the failures a user can act on", () => {
    const cases = [
      ["bash: docker: command not found", "missing"],
      ["docker: 'compose' is not a docker command.", "composeMissing"],
      ["permission denied while trying to connect", "permission"],
      ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "daemon"],
      ["sudo: no tty present and no askpass program specified", "sudo"],
      ["Error: No such container: web", "notFound"],
      ["You cannot remove a running container", "conflict"],
      ["denied: requested access to the resource is denied", "auth"],
    ];
    for (const [stderr, kind] of cases) {
      expect(classifyDockerFailure({ stderr, exitCode: 1 }).kind).toBe(kind);
    }
    expect(classifyDockerFailure({ stderr: "some other failure", exitCode: 1 })).toEqual({
      kind: "error",
      detail: "some other failure",
      message: "some other failure",
    });
  });

  it("keeps the raw stderr and names the fix for each kind", () => {
    const permission = classifyDockerFailure({
      stderr:
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      exitCode: 1,
    });
    expect(permission.detail).toContain("unix:///var/run/docker.sock");
    const described = describeDockerFailure(permission);
    expect(described.text).toMatch(/Docker socket/);
    // The group list is read at login, so the fix has to name the reconnect.
    expect(described.hint).toContain("usermod -aG docker");
    expect(described.hint).toMatch(/reconnect/);

    expect(describeDockerFailure({ kind: "missing" }).hint).toMatch(/PATH/);
    expect(describeDockerFailure({ kind: "daemon" }).hint).toMatch(/systemctl start docker/);
    expect(describeDockerFailure({ kind: "composeMissing" }).hint).toMatch(/docker-compose-plugin/);
    expect(describeDockerFailure({ kind: "sudo" }).hint).toMatch(/NOPASSWD/);
    expect(describeDockerFailure(null).text).toMatch(/failed/);
  });
});

describe("docker client", () => {
  const client = (execute) => createDockerClient(execute);

  it("lists containers and reports a host-level failure instead of an empty tab", async () => {
    const ok = client(async () => ({ stdout: PS_OUTPUT, stderr: "", exitCode: 0 }));
    const listed = await ok.containers();
    expect(listed.ok).toBe(true);
    expect(listed.rows).toHaveLength(3);

    const broken = client(async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      exitCode: 1,
    }));
    const failed = await broken.containers();
    expect(failed.ok).toBe(false);
    expect(failed.rows).toEqual([]);
    expect(failed.failure.kind).toBe("daemon");
  });

  it("resolves with ok:false rather than rejecting when the host says no", async () => {
    const broken = client(async () => ({ stdout: "", stderr: "No such container", exitCode: 1 }));
    const result = await broken.containerAction("stop", "a1b2c3d4e5f6");
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe("notFound");
    expect(result.command).toBe("docker stop a1b2c3d4e5f6");
  });

  it("still throws for a value that failed validation", async () => {
    const noop = client(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await expect(noop.pull("nginx; rm -rf /")).rejects.toThrow(/unexpected image reference/);
    await expect(noop.removeImage("1111; rm -rf /")).rejects.toThrow(/unexpected reference/);
    await expect(noop.inspectContainer("$(whoami)")).rejects.toThrow(/unexpected reference/);
  });

  it("merges both streams for logs and keeps a placeholder when silent", async () => {
    const withOutput = client(async () => ({
      stdout: "listening on :80\n",
      stderr: "warning: deprecated\n",
      exitCode: 0,
    }));
    const logs = await withOutput.logs("web", { tail: 10 });
    expect(logs.text).toBe("listening on :80\nwarning: deprecated");

    const silent = client(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    expect((await silent.logs("web", { tail: 10 })).text).toBe("(no output)");
  });

  it("returns exec output with the container command's exit code", async () => {
    const failing = client(async () => ({ stdout: "", stderr: "not found", exitCode: 127 }));
    const result = await failing.exec("web", "nope", { shell: true });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.text).toBe("not found");
  });

  it("keeps the parsed info when docker info exits non-zero", async () => {
    const half = client(async () => ({
      stdout: JSON.stringify({ Name: "host-1" }),
      stderr: "Cannot connect to the Docker daemon",
      exitCode: 1,
    }));
    const result = await half.info();
    expect(result.ok).toBe(false);
    expect(result.info.name).toBe("host-1");
    expect(result.failure.kind).toBe("daemon");
  });

  it("threads the CLI prefix through every command", async () => {
    const seen = [];
    const sudo = createDockerClient(
      async (command) => {
        seen.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      { bin: "sudo -n docker" },
    );
    await sudo.containers();
    await sudo.volumes();
    expect(seen.every((command) => command.startsWith("sudo -n docker "))).toBe(true);
    expect(sudo.bin).toBe("sudo -n docker");
  });
});

// Mirrors the host contract: one controller hook, panels rendered with
// `{ api, context, controller }`, and a facade whose `sessions.execute` is the
// only backend the plugin may reach.
function fixture() {
  const panels = [];
  const toolbars = [];
  const disposers = [];
  let controllerHook;
  const register = (accept) =>
    vi.fn((item) => {
      accept(item);
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    });
  const execute = vi.fn(async (sessionId, command) => {
    if (command.startsWith("docker ps")) {
      return { stdout: PS_OUTPUT, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("docker images")) {
      return { stdout: IMAGES_OUTPUT, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const store = new Map();
  const api = {
    react: React,
    meta: { pluginId: manifest.id, apiVersion: 1 },
    sessions: { execute },
    storage: {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      remove: (key) => store.delete(key),
    },
    ui: {
      registerPanel: register((panel) => panels.push(panel)),
      registerToolbar: register((item) => toolbars.push(item)),
      registerController: register((hook) => {
        controllerHook = hook;
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return {
    api,
    panels,
    toolbars,
    disposers,
    execute,
    get controllerHook() {
      return controllerHook;
    },
    // The panel renders from an explicit controller snapshot: this suite has no
    // DOM, so effects never run and a mounted controller could not advance past
    // its initial state. The async paths are covered against the client above;
    // these renders assert the static states.
    render(overrides = {}, context = { activeSessionId: "s1", activeSession: { configName: "prod-1" } }) {
      const controller = {
        locale: "en",
        hasSession: Boolean(context.activeSessionId),
        hostLabel: (context.activeSession && context.activeSession.configName) || "",
        bin: "docker",
        binDraft: "docker",
        setBinDraft() {},
        applyBin() {},
        resetBin() {},
        tab: "containers",
        counts: { containers: 0, images: 0, volumes: 0, networks: 0, compose: 0, events: 0 },
        loading: false,
        failure: null,
        notice: null,
        dismissNotice() {},
        say() {},
        refresh() {},
        autoRefresh: 0,
        setAutoRefresh() {},
        query: "",
        setQuery() {},
        stateFilter: "all",
        setStateFilter() {},
        isBusy: () => false,
        anyBusy: false,
        containers: [],
        allContainers: [],
        images: [],
        volumes: [],
        networks: [],
        projects: [],
        composeFailure: null,
        events: [],
        diskRows: [],
        info: null,
        version: null,
        statsEnabled: false,
        setStatsEnabled() {},
        imagesAll: false,
        setImagesAll() {},
        imagesDangling: false,
        setImagesDangling() {},
        eventWindow: "30m",
        setEventWindow() {},
        selection: new Set(),
        toggleSelect() {},
        toggleSelectAll() {},
        clearSelection() {},
        sheet: null,
        closeSheet() {},
        modal: null,
        openModal() {},
        closeModal() {},
        confirm: null,
        askConfirm() {},
        closeConfirm() {},
        runConfirm() {},
        openLogs() {},
        reloadLogs() {},
        openText() {},
        openInspect() {},
        openHistory() {},
        logTail: 200,
        setLogTail() {},
        logTimestamps: false,
        setLogTimestamps() {},
        logSince: "",
        setLogSince() {},
        logFollow: false,
        setLogFollow() {},
        logFilter: "",
        setLogFilter() {},
        logWrap: true,
        setLogWrap() {},
        execState: null,
        openExec() {},
        patchExec() {},
        runExec() {},
        searchState: { term: "", rows: [], pending: false, error: "" },
        runSearch() {},
        client: {},
        task() {},
        bulkTask() {},
        ...overrides,
      };
      return renderToStaticMarkup(panels.at(-1).render({ api, context, controller }));
    },
  };
}

describe("docker plugin activation", () => {
  it("registers a panel, a toolbar button and exactly one controller", async () => {
    const host = fixture();
    const dispose = await activate(host.api);
    expect(manifest.builtin).toBe(false);
    expect(manifest.apiVersion).toBe(1);
    expect(host.panels).toHaveLength(1);
    expect(host.panels[0].id).toBe(manifest.contributes.panels[0].id);
    expect(host.panels[0].defaultVisible).toBeUndefined();
    expect(host.toolbars[0].panelId).toBe(host.panels[0].id);
    // The icon is the plugin's own asset, resolved against its module URL.
    expect(host.toolbars[0].icon).toMatch(/icon\.svg$/);
    expect(typeof host.controllerHook).toBe("function");
    dispose();
    for (const unregister of host.disposers) {
      expect(unregister).toHaveBeenCalledOnce();
    }
  });

  it("asks for a session instead of running docker without one", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({}, { activeSessionId: null, activeSession: null });
    expect(html).toContain("No active session");
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("renders the container list with state-aware actions", async () => {
    const host = fixture();
    await activate(host.api);
    const containers = parseContainers(PS_OUTPUT);
    const html = host.render({
      containers,
      allContainers: containers,
      counts: { containers: 3, images: 2, volumes: 0, networks: 0, compose: 1, events: 0 },
    });
    expect(html).toContain("prod-1");
    expect(html).toContain("web");
    expect(html).toContain("nginx:1.27");
    expect(html).toContain("0.0.0.0:8080-&gt;80/tcp");
    // A running container offers Stop; a stopped one offers Start.
    expect(html).toContain(">Stop<");
    expect(html).toContain(">Start<");
    // The compose project shows as a tag on the row.
    expect(html).toContain("shop");
    // Every action button names the command it will run.
    expect(html).toContain('title="docker stop web"');
    expect(html).toContain('title="docker logs web"');
  });

  it("shows the empty state rather than a blank table", async () => {
    const host = fixture();
    await activate(host.api);
    expect(host.render()).toContain("No containers match.");
    expect(host.render({ tab: "images" })).toContain("No images match.");
    expect(host.render({ tab: "volumes" })).toContain("No volumes on this host.");
    expect(host.render({ tab: "networks" })).toContain("No networks on this host.");
    expect(host.render({ tab: "events" })).toContain("No events in this window.");
    expect(host.render({ tab: "compose" })).toContain("No compose projects on this host.");
  });

  it("explains an unusable host instead of showing a raw error", async () => {
    const host = fixture();
    await activate(host.api);
    const missing = host.render({ failure: { kind: "missing" } });
    expect(missing).toContain("docker was not found on the remote host");
    expect(missing).toContain("Retry");

    const denied = host.render({
      failure: {
        kind: "permission",
        detail: "permission denied while trying to connect to the Docker daemon socket",
      },
    });
    expect(denied).toContain("cannot reach the Docker socket");
    expect(denied).toContain("usermod -aG docker");
    expect(denied).toContain("permission denied while trying to connect");
  });

  it("renders the images tab with pull, search and per-row actions", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ tab: "images", images: parseImages(IMAGES_OUTPUT) });
    expect(html).toContain("nginx:1.27");
    expect(html).toContain("Pull…");
    expect(html).toContain("Search Hub…");
    expect(html).toContain("dangling");
    expect(html).toContain('title="docker run nginx:1.27"');
  });

  it("renders the bulk action bar only when rows are selected", async () => {
    const host = fixture();
    await activate(host.api);
    const containers = parseContainers(PS_OUTPUT);
    expect(host.render({ containers, allContainers: containers })).not.toContain("1 selected");
    const html = host.render({
      containers,
      allContainers: containers,
      selection: new Set([containers[0].id]),
    });
    expect(html).toContain("1 selected");
    expect(html).toContain("Clear");
  });

  it("renders the log sheet with its docker logs options", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({
      sheet: {
        kind: "logs",
        target: { kind: "container", reference: "a1b2c3d4e5f6", title: "web", command: "docker logs web" },
        text: "listening on :80",
        pending: false,
      },
    });
    expect(html).toContain("Logs · web");
    expect(html).toContain("listening on :80");
    expect(html).toContain("--tail 200");
    expect(html).toContain("follow");
    expect(html).toContain("Reload");
  });

  it("renders the inspect sheet summary with the raw JSON available", async () => {
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
    const html = host.render({
      sheet: { kind: "inspect", title: "web", subtitle: "a1b2c3d4e5f6", summary: parseInspect(raw), raw, pending: false },
    });
    expect(html).toContain("Inspect · web");
    expect(html).toContain("nginx:1.27");
    expect(html).toContain("bridge");
    expect(html).toContain("Raw JSON");
  });

  it("renders the run-container form with a live command preview", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ modal: { kind: "run", image: "nginx:1.27" } });
    expect(html).toContain("Run a container");
    expect(html).toContain("Command preview");
    // The preview is built by the same builder the action uses.
    expect(html).toContain("docker run -d nginx:1.27");
  });

  it("renders a destructive confirmation with the exact command", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({
      confirm: {
        title: "Remove this volume?",
        command: "docker volume rm data",
        confirmLabel: "Remove",
        tone: "danger",
        body: "The data in it is deleted and cannot be recovered.",
        run() {},
      },
    });
    expect(html).toContain("Remove this volume?");
    expect(html).toContain("docker volume rm data");
    expect(html).toContain("cannot be recovered");
  });

  it("groups compose services under their project", async () => {
    const host = fixture();
    await activate(host.api);
    const containers = parseContainers(PS_OUTPUT);
    const html = host.render({
      tab: "compose",
      allContainers: containers,
      projects: [
        {
          name: "shop",
          files: ["/srv/shop/docker-compose.yml"],
          workingDir: "/srv/shop",
          status: "running(1)",
          services: containers.slice(0, 1),
          running: 1,
        },
      ],
    });
    expect(html).toContain("shop");
    expect(html).toContain("/srv/shop/docker-compose.yml");
    expect(html).toContain('title="docker compose -p shop up -d"');
  });

  it("renders the system tab from docker info, version and system df", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({
      tab: "system",
      info: parseInfo(
        JSON.stringify({
          Name: "host-1",
          ServerVersion: "27.0.3",
          OSType: "linux",
          Architecture: "x86_64",
          NCPU: 8,
          MemTotal: 16_000_000_000,
          Containers: 5,
          ContainersRunning: 3,
          Images: 12,
          Driver: "overlay2",
        }),
      ),
      version: { clientVersion: "27.0.3", serverApi: "1.46" },
      diskRows: parseSystemDf(
        JSON.stringify({ Type: "Images", TotalCount: "12", Active: "3", Size: "3.1GB", Reclaimable: "1.2GB (38%)" }),
      ),
    });
    expect(html).toContain("27.0.3");
    expect(html).toContain("overlay2");
    expect(html).toContain("Reclaimable");
    expect(html).toContain("3.1GB");
    expect(html).toContain("Prune…");
  });

  it("shows a notice above the list", async () => {
    const host = fixture();
    await activate(host.api);
    expect(host.render({ notice: { tone: "success", text: "docker stop web" } })).toContain(
      "docker stop web",
    );
  });
});
