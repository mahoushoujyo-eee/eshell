import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { activate } from "../../../examples/xray-plugin/index.js";
import manifest from "../../../examples/xray-plugin/manifest.json";
import {
  backupConfigCommand,
  classifyFailure,
  decodeBase64,
  describeFailure,
  detectCommand,
  detectScript,
  directProbeCommand,
  enrichGroups,
  fetchCommand,
  groupNodes,
  heredocDelimiter,
  isSafeTag,
  isSafeUrl,
  listGroups,
  listNodes,
  logTailCommand,
  maskUrl,
  nodeTag,
  parseConfig,
  parseDetectOutput,
  parseNodeUri,
  parseObservatoryLog,
  parseServiceState,
  parseShadowsocks,
  parseSubscription,
  parseTrojan,
  parseVless,
  parseVmess,
  probeCommand,
  readConfigCommand,
  removeGroup,
  replaceNodes,
  restartCommand,
  restoreConfigCommand,
  sanitizePrivilege,
  serviceStateCommand,
  setGroupSelector,
  summarize,
  testConfigCommand,
  testConfigFallbackCommand,
  upsertGroup,
  writeConfigCommand,
} from "../../../examples/xray-plugin/xray.js";
import { createXrayClient } from "../../../examples/xray-plugin/client.js";
import { createXrayController } from "../../../examples/xray-plugin/controller/index.js";
import { createXrayPanel } from "../../../examples/xray-plugin/panel/index.js";
import { createUi } from "../../../examples/xray-plugin/ui/index.js";

// A config with two nodes of one group, a plain outbound and a rule that
// sends traffic to the group.
const CONFIG = {
  log: { access: "/var/log/xray/access.log" },
  inbounds: [
    { tag: "socks-in", listen: "127.0.0.1", port: 10808, protocol: "socks", settings: {} },
  ],
  outbounds: [
    {
      tag: "hk-01",
      protocol: "vless",
      settings: { vnext: [{ address: "hk1.example.com", port: 443, users: [{ id: "u1" }] }] },
      streamSettings: { network: "ws", security: "tls" },
    },
    {
      tag: "hk-02",
      protocol: "vless",
      settings: { vnext: [{ address: "hk2.example.com", port: 8443, users: [{ id: "u2" }] }] },
      streamSettings: { network: "tcp", security: "reality" },
    },
    { tag: "direct", protocol: "freedom", settings: {} },
  ],
  routing: {
    domainStrategy: "IPIfNonMatch",
    rules: [{ type: "field", balancerTag: "hk", domain: ["geosite:cn"] }],
    balancers: [{ tag: "hk", selector: ["hk"], strategy: { type: "random" } }],
  },
};

const VLESS_URI =
  "vless://11111111-2222-3333-4444-555555555555@hk.example.com:443?encryption=none&security=reality&sni=hk.example.com&fp=chrome&pbk=PUBLICKEY&sid=abcd&spx=%2F&type=ws&path=%2Fpath&host=hk.example.com&flow=xtls-rprx-vision#Hong%20Kong%2001";

const VMESS_JSON = {
  v: "2",
  ps: "Tokyo 02",
  add: "tk.example.com",
  port: "443",
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  aid: "0",
  scy: "auto",
  net: "ws",
  type: "none",
  host: "tk.example.com",
  path: "/ws",
  tls: "tls",
  sni: "tk.example.com",
};

const TROJAN_URI =
  "trojan://Pa55word@tr.example.com:443?security=tls&sni=tr.example.com&type=tcp#Tokyo%2003";

const SS_URI = "ss://YWVzLTI1Ni1nY206c2VjcmV0@192.16.3.4:8388#Osaka%2004";

describe("command builders", () => {
  it("asks the host for the binary, the config and the service in one call", () => {
    const command = detectCommand();
    expect(command.startsWith("sh -c ")).toBe(true);
    expect(command).toContain("/usr/local/etc/xray/config.json");
    expect(command).toContain("systemctl");
    // The script is wrapped in single quotes, so it may not contain one.
    const script = command.slice("sh -c ".length);
    expect(script.startsWith("'")).toBe(true);
    expect(script.slice(1, -1)).not.toContain("'");
  });

  it("reads the detection answers", () => {
    const info = parseDetectOutput(
      [
        "bin=/usr/local/bin/xray",
        "home=/root",
        "config=/usr/local/etc/xray/config.json",
        "unit=xray.service",
        "systemctl=yes",
        "writable=no",
        "readable=yes",
        "dir=/usr/local/etc/xray",
        "dirwritable=yes",
        "sudo=yes",
        "fetch=curl",
        "proc=/usr/local/bin/xray run -c /usr/local/etc/xray/config.json",
      ].join("\n"),
    );
    expect(info.bin).toBe("/usr/local/bin/xray");
    expect(info.config).toBe("/usr/local/etc/xray/config.json");
    expect(info.systemctl).toBe(true);
    expect(info.writable).toBe(false);
    expect(info.readable).toBe(true);
    expect(info.dir).toBe("/usr/local/etc/xray");
    expect(info.dirWritable).toBe(true);
    expect(info.sudo).toBe(true);
    expect(info.fetch).toBe("curl");
  });

  it("reads the service state even when the unit is stopped", () => {
    expect(parseServiceState("inactive\ndisabled")).toEqual({
      active: "inactive",
      enabled: "disabled",
    });
  });

  it("writes the config through a quoted heredoc", () => {
    const command = writeConfigCommand({
      path: "/usr/local/etc/xray/config.json",
      json: '{"outbounds":[]}',
      privilege: "",
      delimiter: "XRAY_EOF_1",
    });
    expect(command).toContain('cp -p "/usr/local/etc/xray/config.json"');
    expect(command).toContain('mv -f "/usr/local/etc/xray/config.json.eshell-tmp"');
    expect(command).toContain("<<'XRAY_EOF_1'");
    expect(command.endsWith("\nXRAY_EOF_1")).toBe(true);
    // The body travels on stdin, so the shell never expands it.
    expect(command).toContain("{\"outbounds\":[]}");
  });

  it("refuses a config path the shell could act on", () => {
    expect(() =>
      writeConfigCommand({
        path: '/etc/xray/$(id).json',
        json: "{}",
        privilege: "",
        delimiter: "XRAY_EOF_3",
      }),
    ).toThrow();
  });

  it("never lets a value break out of its quoting", () => {
    const command = writeConfigCommand({
      path: "/etc/xray/config.json",
      json: "{}",
      privilege: "sudo -n",
      delimiter: "XRAY_EOF_2",
    });
    expect(command.startsWith("sudo -n sh -c ")).toBe(true);
    expect(command).toContain("'cp -p \"/etc/xray/config.json\"");
  });

  it("keeps the backup next to the config", () => {
    expect(backupConfigCommand("/etc/xray/config.json", "")).toBe(
      "cp -p '/etc/xray/config.json' '/etc/xray/config.json.eshell-backup'",
    );
  });

  it("picks a heredoc delimiter the body cannot contain", () => {
    expect(heredocDelimiter("{}", "1")).toBe("XRAY_EOF_1");
    expect(heredocDelimiter("a\nXRAY_EOF_1\nb", "1")).toBe("XRAY_EOF_1_1");
  });

  it("validates the config with the spelling the host understands", () => {
    expect(testConfigCommand({ path: "/etc/xray/config.json", bin: "/usr/bin/xray", privilege: "" })).toBe(
      "'/usr/bin/xray' run -test -config '/etc/xray/config.json'",
    );
    expect(
      testConfigFallbackCommand({ path: "/etc/xray/config.json", bin: "/usr/bin/xray", privilege: "" }),
    ).toBe("'/usr/bin/xray' -test -config '/etc/xray/config.json'");
  });

  it("restarts the service through the manager the host has", () => {
    expect(restartCommand({ unit: "xray.service", privilege: "", systemctl: true })).toBe(
      "systemctl restart xray.service",
    );
    expect(restartCommand({ unit: "xray", privilege: "sudo -n", systemctl: false })).toBe(
      "sudo -n service xray restart",
    );
  });

  it("downloads the subscription on the host", () => {
    expect(fetchCommand({ url: "https://example.com/sub", tool: "curl" })).toContain(
      "curl -fsSL --max-time 30",
    );
    expect(fetchCommand({ url: "https://example.com/sub", tool: "wget" })).toContain("wget -q -O -");
    expect(fetchCommand({ url: "https://example.com/sub", tool: "curl" })).toContain(
      "'https://example.com/sub'",
    );
  });

  it("measures the live path through the local socks inbound", () => {
    const command = probeCommand({ socksPort: 10808, url: "https://example.com" });
    expect(command).toContain("--proxy socks5h://127.0.0.1:10808");
    expect(command).toContain("'https://example.com'");
  });
});

describe("value validation", () => {
  it("accepts only the charsets that cannot carry shell syntax", () => {
    expect(isSafeTag("hk")).toBe(true);
    expect(isSafeTag("hk-01")).toBe(true);
    expect(isSafeTag("hk 01")).toBe(false);
    expect(isSafeTag("hk;rm -rf /")).toBe(false);
    expect(isSafeTag("-hk")).toBe(false);
    expect(isSafeUrl("https://example.com/sub?token=1")).toBe(true);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("https://example.com/a b")).toBe(false);
  });

  it("refuses a privilege prefix that could prompt", () => {
    expect(sanitizePrivilege("")).toBe("");
    expect(sanitizePrivilege("sudo -n")).toBe("sudo -n");
    expect(sanitizePrivilege("sudo")).toBe("");
    expect(sanitizePrivilege("sudo -n -u root")).toBe("sudo -n -u root");
    expect(sanitizePrivilege("rm -rf /")).toBe("");
  });
});

describe("the config model", () => {
  it("reads the groups and the nodes out of the config", () => {
    const groups = listGroups(CONFIG);
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBe("hk");
    expect(groups[0].selector).toEqual(["hk"]);
    expect(groups[0].strategy).toBe("random");
    expect(groups[0].ruleCount).toBe(1);

    const nodes = listNodes(CONFIG);
    expect(nodes.map((node) => node.tag)).toEqual(["hk-01", "hk-02", "direct"]);
    expect(nodes[0].address).toBe("hk1.example.com");
    expect(nodes[0].port).toBe(443);
    expect(nodes[0].network).toBe("ws");
    expect(nodes[0].security).toBe("tls");
    // `freedom` is not a node: it has no endpoint to dial.
    expect(nodes[2].isNode).toBe(false);
  });

  it("refuses a config that is not JSON", () => {
    expect(parseConfig("{oops")).toEqual({ ok: false, error: expect.any(String) });
    expect(parseConfig("").ok).toBe(false);
    expect(parseConfig('{"outbounds":[]}').ok).toBe(true);
  });

  it("adds a balancer and keeps the strategy settings of an unchanged strategy", () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    config.routing.balancers[0].strategy = { type: "leastPing", settings: { expectedIPs: ["1.2.3.4"] } };
    upsertGroup(config, { tag: "hk", selector: ["hk", "jp"], strategy: "leastPing" });
    expect(config.routing.balancers[0].selector).toEqual(["hk", "jp"]);
    expect(config.routing.balancers[0].strategy.settings).toEqual({ expectedIPs: ["1.2.3.4"] });

    // A different strategy has no use for the old settings.
    upsertGroup(config, { tag: "hk", selector: ["hk"], strategy: "random" });
    expect(config.routing.balancers[0].strategy).toEqual({ type: "random" });
  });

  it("removes a balancer", () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    expect(removeGroup(config, "hk")).toBe(true);
    expect(removeGroup(config, "hk")).toBe(false);
    expect(config.routing.balancers).toEqual([]);
    // The rules are left alone: the panel reads them, it does not write them.
    expect(config.routing.rules).toHaveLength(1);
  });

  it("replaces the nodes a subscription owns, and only those", () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    const result = replaceNodes(config, "hk", [
      { protocol: "vless", settings: { vnext: [{ address: "new.example.com", port: 443 }] } },
    ]);
    expect(result.removed).toBe(2);
    expect(result.added).toBe(1);
    const tags = config.outbounds.map((outbound) => outbound.tag);
    expect(tags).toEqual(["direct", "hk-01"]);
    expect(config.outbounds[1].settings.vnext[0].address).toBe("new.example.com");
    // A different prefix is untouched.
    expect(config.outbounds.filter((outbound) => outbound.tag === "direct")).toHaveLength(1);
  });

  it("tags the nodes of a prefix in order", () => {
    expect(nodeTag("hk", 0)).toBe("hk-01");
    expect(nodeTag("hk", 9)).toBe("hk-10");
  });

  it("summarises what the config holds", () => {
    const summary = summarize(CONFIG);
    expect(summary.inboundCount).toBe(1);
    expect(summary.outboundCount).toBe(3);
    expect(summary.nodeCount).toBe(2);
    expect(summary.groupCount).toBe(1);
    expect(summary.ruleCount).toBe(1);
    expect(summary.observatory).toBe(false);
    expect(summary.logPath).toBe("/var/log/xray/access.log");
  });
});

describe("share links", () => {
  it("reads a vless link with reality and ws", () => {
    const node = parseVless(VLESS_URI);
    expect(node.protocol).toBe("vless");
    expect(node.name).toBe("Hong Kong 01");
    expect(node.settings.vnext[0].address).toBe("hk.example.com");
    expect(node.settings.vnext[0].port).toBe(443);
    expect(node.settings.vnext[0].users[0].id).toBe("11111111-2222-3333-4444-555555555555");
    expect(node.settings.vnext[0].users[0].flow).toBe("xtls-rprx-vision");
    expect(node.streamSettings.network).toBe("ws");
    expect(node.streamSettings.security).toBe("reality");
    expect(node.streamSettings.realitySettings.publicKey).toBe("PUBLICKEY");
    expect(node.streamSettings.realitySettings.shortId).toBe("abcd");
    expect(node.streamSettings.realitySettings.fingerprint).toBe("chrome");
    expect(node.streamSettings.wsSettings.path).toBe("/path");
    expect(node.streamSettings.wsSettings.headers.Host).toBe("hk.example.com");
  });

  it("reads a vmess link", () => {
    const node = parseVmess(`vmess://${btoa(JSON.stringify(VMESS_JSON))}`);
    expect(node.protocol).toBe("vmess");
    expect(node.name).toBe("Tokyo 02");
    expect(node.settings.vnext[0].address).toBe("tk.example.com");
    expect(node.settings.vnext[0].users[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(node.settings.vnext[0].users[0].security).toBe("auto");
    expect(node.streamSettings.network).toBe("ws");
    expect(node.streamSettings.security).toBe("tls");
    expect(node.streamSettings.wsSettings.path).toBe("/ws");
  });

  it("reads a trojan link", () => {
    const node = parseTrojan(TROJAN_URI);
    expect(node.protocol).toBe("trojan");
    expect(node.settings.servers[0].password).toBe("Pa55word");
    expect(node.settings.servers[0].address).toBe("tr.example.com");
  });

  it("reads a shadowsocks link in the SIP002 shape", () => {
    const node = parseShadowsocks(SS_URI);
    expect(node.protocol).toBe("shadowsocks");
    expect(node.name).toBe("Osaka 04");
    expect(node.settings.servers[0].method).toBe("aes-256-gcm");
    expect(node.settings.servers[0].password).toBe("secret");
    expect(node.settings.servers[0].address).toBe("192.16.3.4");
    expect(node.settings.servers[0].port).toBe(8388);
  });

  it("reads a shadowsocks link in the legacy shape", () => {
    const node = parseShadowsocks(
      `ss://${btoa("aes-128-gcm:pass@1.2.3.4:8388")}#Legacy`,
    );
    expect(node.settings.servers[0].method).toBe("aes-128-gcm");
    expect(node.settings.servers[0].password).toBe("pass");
    expect(node.settings.servers[0].address).toBe("1.2.3.4");
    expect(node.settings.servers[0].port).toBe(8388);
  });

  it("refuses a link it cannot read", () => {
    expect(parseNodeUri("vless://")).toBeNull();
    expect(parseNodeUri("http://example.com")).toBeNull();
    expect(parseNodeUri("vmess://not-base64!!")).toBeNull();
  });

  it("decodes base64 and base64url", () => {
    expect(decodeBase64(btoa("hello"))).toBe("hello");
    expect(decodeBase64("aGVsbG8")).toBe("hello");
  });
});

describe("subscriptions", () => {
  const list = [VLESS_URI, TROJAN_URI, SS_URI].join("\n");

  it("reads a plain link list", () => {
    const parsed = parseSubscription(list);
    expect(parsed.ok).toBe(true);
    expect(parsed.format).toBe("uri-list");
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[0].protocol).toBe("vless");
  });

  it("reads a base64 blob", () => {
    const parsed = parseSubscription(btoa(list));
    expect(parsed.ok).toBe(true);
    expect(parsed.format).toBe("base64");
    expect(parsed.nodes).toHaveLength(3);
  });

  it("reads an xray json config", () => {
    const parsed = parseSubscription(
      JSON.stringify({ outbounds: [{ tag: "n1", protocol: "vless", settings: {} }] }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.format).toBe("xray-json");
    expect(parsed.nodes[0].name).toBe("n1");
  });

  it("says plainly that it does not read a clash yaml", () => {
    const parsed = parseSubscription("proxies:\n  - name: HK\n    type: vless\n");
    expect(parsed.ok).toBe(false);
    expect(parsed.format).toBe("clash");
    expect(parsed.message).toContain("Clash YAML");
  });

  it("counts the entries it skipped", () => {
    const parsed = parseSubscription(`${VLESS_URI}\nnot-a-link\n`);
    expect(parsed.ok).toBe(true);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it("refuses an empty body", () => {
    expect(parseSubscription("").ok).toBe(false);
  });
});

describe("the observatory log", () => {
  it("reads the delay of each outbound", () => {
    const text = [
      "2024/01/01 00:00:00 [Info] [1234] app/log: access log",
      '{"outboundTag":"hk-01","delay":132,"lastTestTime":"2024-01-01T00:00:00Z","ip":"1.2.3.4"}',
      '{"outboundTag":"hk-02","delay":0,"lastTestTime":"2024-01-01T00:00:10Z"}',
      "not json at all",
    ].join("\n");
    const delays = parseObservatoryLog(text);
    expect(delays["hk-01"].delay).toBe(132);
    expect(delays["hk-01"].ip).toBe("1.2.3.4");
    expect(delays["hk-02"].delay).toBe(0);
    expect(delays["hk-03"]).toBeUndefined();
  });
});

describe("failure classification", () => {
  it("recognises the failures a user can act on", () => {
    expect(classifyFailure({ stderr: "xray: command not found", exitCode: 127 }).kind).toBe("missing");
    expect(classifyFailure({ stderr: "cp: Permission denied", exitCode: 1 }).kind).toBe("permission");
    expect(
      classifyFailure({ stderr: "sudo: a password is required", exitCode: 1 }).kind,
    ).toBe("sudo");
    expect(classifyFailure({ stderr: "curl: (22) The requested URL returned error: 403", exitCode: 22 }).kind).toBe(
      "httpError",
    );
    expect(classifyFailure({ stderr: "failed to parse json", exitCode: 1 }).kind).toBe("invalidConfig");
  });

  it("keeps the raw output for the diagnosis", () => {
    const failure = classifyFailure({ stderr: "something odd", exitCode: 2 });
    expect(failure.detail).toBe("something odd");
    expect(describeFailure(failure).text).toBeTruthy();
  });
});

describe("the write path", () => {
  const fakeHost = ({ valid = true, active = "active" } = {}) => {
    const calls = [];
    const execute = vi.fn(async (command) => {
      calls.push(command);
      if (command.includes("run -test")) {
        return valid
          ? { stdout: "Configuration OK", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "failed to parse config: invalid character", exitCode: 1 };
      }
      if (command.startsWith("systemctl is-active")) {
        return { stdout: `${active}\nenabled`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    return { execute, calls };
  };

  it("backs up, writes, validates and only then restarts", async () => {
    const host = fakeHost();
    const client = createXrayClient(host.execute);
    const result = await client.applyConfig({
      path: "/etc/xray/config.json",
      json: '{"outbounds":[]}',
      bin: "/usr/local/bin/xray",
      privilege: "",
      unit: "xray.service",
    });
    expect(result.ok).toBe(true);
    expect(result.restarted).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual([
      "backup",
      "write",
      "validate",
      "restart",
      "state",
    ]);
    expect(host.calls[0]).toContain("cp -p");
    expect(host.calls[1]).toContain("<<'");
    expect(host.calls[2]).toContain("run -test");
    expect(host.calls[3]).toContain("systemctl restart");
  });

  it("restores the backup and does not restart when xray refuses the config", async () => {
    const host = fakeHost({ valid: false });
    const client = createXrayClient(host.execute);
    const result = await client.applyConfig({
      path: "/etc/xray/config.json",
      json: '{"outbounds":[]}',
      bin: "/usr/local/bin/xray",
      privilege: "",
      unit: "xray.service",
    });
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe("invalidConfig");
    expect(result.restored).toBe(true);
    expect(host.calls.some((command) => command.includes("systemctl restart"))).toBe(false);
    // The backup is put back over the config.
    expect(host.calls[host.calls.length - 1]).toContain("eshell-backup");
  });

  it("refuses to write when there is no binary to validate with", async () => {
    const host = fakeHost();
    const client = createXrayClient(host.execute);
    const result = await client.applyConfig({
      path: "/etc/xray/config.json",
      json: "{}",
      bin: "",
      privilege: "",
      unit: "xray.service",
    });
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe("missing");
  });

  it("reports a service that did not come back", async () => {
    const host = fakeHost({ active: "failed" });
    const client = createXrayClient(host.execute);
    const result = await client.applyConfig({
      path: "/etc/xray/config.json",
      json: "{}",
      bin: "/usr/local/bin/xray",
      privilege: "",
      unit: "xray.service",
    });
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe("service");
  });
});

describe("the derived views", () => {
  it("keeps the member list while a node is pinned", () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    setGroupSelector(config, "hk", ["hk-01"]);
    const groups = enrichGroups(config, { hk: { autoSelector: ["hk"] } });
    expect(groups[0].isPinned).toBe(true);
    expect(groups[0].pinnedTag).toBe("hk-01");
    // The group still has two candidates; only the selector was narrowed.
    expect(groups[0].memberCount).toBe(2);
    expect(groups[0].autoSelector).toEqual(["hk"]);
  });

  it("marks a group no rule uses", () => {
    const groups = enrichGroups(CONFIG, {});
    expect(groups[0].unused).toBe(false);
    const withoutRule = JSON.parse(JSON.stringify(CONFIG));
    withoutRule.routing.rules = [];
    expect(enrichGroups(withoutRule, {})[0].unused).toBe(true);
  });

  it("masks the token of a subscription url", () => {
    expect(maskUrl("https://example.com/sub?token=abcdef123456")).toContain("example.com");
    expect(maskUrl("https://example.com/sub?token=abcdef123456")).not.toContain("abcdef123456");
    expect(maskUrl("")).toBe("");
  });
});

// A POSIX shell, when the machine has one. The plugin ships commands to a
// remote host, so the only way to know a command is even parseable is to
// hand it to a shell. Without a shell the suite skips these checks.
const findShell = () => {
  const candidates = [
    "sh",
    "/bin/sh",
    "/usr/bin/sh",
    "C:/app/Cygwin/bin/sh.exe",
    "C:/Program Files/Git/usr/bin/sh.exe",
  ];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
      if (!probe.error && probe.status === 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
};

const SHELL = findShell();

describe.skipIf(!SHELL)("the commands are valid shell", () => {
  /** `sh -n` parses the script without running it. */
  const parses = (command) => {
    const result = spawnSync(SHELL, ["-n"], { input: command, encoding: "utf8" });
    return { ok: result.status === 0, status: result.status, stderr: (result.stderr || "").trim() };
  };

  it("parses the detection script", () => {
    const result = parses(detectCommand());
    expect(result.stderr).toBe("");
    expect(result.ok).toBe(true);
  });

  it("runs the detection script and answers every question", () => {
    const script = detectScript();
    const result = spawnSync(SHELL, ["-c", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    const info = parseDetectOutput(result.stdout);
    // Every probe reports, even where the tool is absent.
    expect(info).toHaveProperty("bin");
    expect(info).toHaveProperty("config");
    expect(info).toHaveProperty("unit");
    expect(info).toHaveProperty("systemctl");
    expect(info).toHaveProperty("writable");
    expect(info).toHaveProperty("sudo");
    expect(info).toHaveProperty("fetch");
    // The answers are read as booleans, not as the raw "yes"/"no".
    expect(typeof info.systemctl).toBe("boolean");
    expect(typeof info.writable).toBe("boolean");
    expect(typeof info.sudo).toBe("boolean");
  });

  it("parses every other command the panel builds", () => {
    const commands = [
      readConfigCommand("/etc/xray/config.json"),
      backupConfigCommand("/etc/xray/config.json", ""),
      backupConfigCommand("/etc/xray/config.json", "sudo -n"),
      writeConfigCommand({
        path: "/etc/xray/config.json",
        json: '{"outbounds":[]}',
        privilege: "",
        delimiter: "XRAY_EOF_1",
      }),
      writeConfigCommand({
        path: "/etc/xray/config.json",
        json: '{"a":"b"}',
        privilege: "sudo -n",
        delimiter: "XRAY_EOF_2",
      }),
      restoreConfigCommand("/etc/xray/config.json", "sudo -n"),
      testConfigCommand({ path: "/etc/xray/config.json", bin: "/usr/local/bin/xray", privilege: "" }),
      testConfigFallbackCommand({
        path: "/etc/xray/config.json",
        bin: "/usr/local/bin/xray",
        privilege: "",
      }),
      restartCommand({ unit: "xray.service", privilege: "", systemctl: true }),
      restartCommand({ unit: "xray", privilege: "sudo -n", systemctl: false }),
      serviceStateCommand("xray.service"),
      fetchCommand({ url: "https://example.com/sub", tool: "curl" }),
      fetchCommand({ url: "https://example.com/sub", tool: "wget" }),
      probeCommand({ socksPort: 10808, url: "https://example.com" }),
      directProbeCommand({ url: "https://example.com" }),
      logTailCommand("/var/log/xray/access.log", 200),
    ];
    for (const command of commands) {
      const result = parses(command);
      expect({ command, stderr: result.stderr }).toEqual({ command, stderr: "" });
      expect(result.ok).toBe(true);
    }
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
  const execute = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
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
    render(overrides = {}, context = { activeSessionId: "s1", activeSession: { configName: "edge-1" } }) {
      const groups = enrichGroups(CONFIG, {});
      const controller = {
        locale: "en",
        hasSession: Boolean(context.activeSessionId),
        hostLabel: (context.activeSession && context.activeSession.configName) || "",
        translate: (key) => key,
        info: { bin: "/usr/local/bin/xray", config: "/etc/xray/config.json", unit: "xray.service", systemctl: true, writable: true, sudo: false, fetch: "curl" },
        version: "1.8.24",
        service: { active: "active", enabled: "enabled" },
        effective: {
          bin: "/usr/local/bin/xray",
          configPath: "/etc/xray/config.json",
          unit: "xray.service",
          privilege: "",
          systemctl: true,
          writable: true,
          sudo: false,
          fetchTool: "curl",
        },
        loading: false,
        failure: null,
        config: CONFIG,
        summary: summarize(CONFIG),
        groups,
        subscriptions: [
          {
            id: "sub-1",
            name: "Hong Kong",
            url: "https://example.com/sub?token=abcdef123456",
            prefix: "hk",
            updatedAt: 0,
            nodeCount: 2,
            configuredCount: 2,
            outdated: false,
            nodes: [],
          },
        ],
        activeGroup: groups[0],
        activeNodes: groupNodes(CONFIG, groups[0], { "hk-01": "Hong Kong 01" }),
        delays: {},
        names: { "hk-01": "Hong Kong 01" },
        tab: "groups",
        setTab() {},
        query: "",
        setQuery() {},
        selectedGroup: "hk",
        setSelectedGroup() {},
        notice: null,
        dismissNotice() {},
        say() {},
        busy: new Set(),
        isBusy: () => false,
        anyBusy: false,
        modal: null,
        openModal() {},
        closeModal() {},
        confirm: null,
        openConfirm() {},
        closeConfirm() {},
        runConfirm() {},
        refresh() {},
        openSettings() {},
        probePath() {},
        saveGroup() {},
        requestDeleteGroup() {},
        selectNode() {},
        restoreAuto() {},
        saveSubscription() {},
        updateSubscription() {},
        requestDeleteSubscription() {},
        task() {},
        ...overrides,
      };
      return renderToStaticMarkup(panels.at(-1).render({ api, context, controller }));
    },
  };
}

describe("xray plugin activation", () => {
  it("registers a panel, a toolbar button and exactly one controller", async () => {
    const host = fixture();
    const dispose = await activate(host.api);
    expect(manifest.builtin).toBe(false);
    expect(manifest.apiVersion).toBe(1);
    expect(host.panels).toHaveLength(1);
    expect(host.panels[0].id).toBe(manifest.contributes.panels[0].id);
    expect(host.toolbars[0].panelId).toBe(host.panels[0].id);
    expect(host.toolbars[0].icon).toMatch(/icon\.svg$/);
    expect(typeof host.controllerHook).toBe("function");
    dispose();
    for (const unregister of host.disposers) {
      expect(unregister).toHaveBeenCalledOnce();
    }
  });

  it("asks for a session instead of running xray without one", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({}, { activeSessionId: null, activeSession: null });
    expect(html).toContain("No active session");
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("shows what the host has in the header", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render();
    expect(html).toContain("/usr/local/bin/xray");
    expect(html).toContain("/etc/xray/config.json");
    expect(html).toContain("v1.8.24");
    expect(html).toContain("active");
  });

  it("lists the groups with their members and their strategy", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render();
    expect(html).toContain("hk");
    expect(html).toContain("Random");
    expect(html).toContain("automatic");
  });

  it("lists the subscriptions with a masked url", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ tab: "subscriptions" });
    expect(html).toContain("Hong Kong");
    expect(html).toContain("example.com");
    expect(html).not.toContain("abcdef123456");
  });

  it("lists the nodes of the selected group", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ tab: "nodes" });
    expect(html).toContain("hk1.example.com");
    expect(html).toContain("Hong Kong 01");
    expect(html).toContain("standby");
  });
});

// The real controller and the real panel, rendered together: the controller
// hook runs inside the harness, so the panel is rendered from the snapshot the
// controller actually publishes.
describe("the panel and the controller together", () => {
  const renderReal = ({ activeSessionId = null, api = {} } = {}) => {
    const react = React;
    const ui = createUi(react);
    const useXrayController = createXrayController(react, { t: (key) => key });
    const renderPanel = createXrayPanel({ react, ui, t: (key) => key });
    const storage = new Map();
    const facade = {
      storage: {
        get: (key) => storage.get(key),
        set: (key, value) => storage.set(key, value),
        remove: (key) => storage.delete(key),
      },
      sessions: { execute: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) },
      ...api,
    };
    const Harness = () => {
      const controller = useXrayController({
        api: facade,
        activeSessionId,
        activeSession: activeSessionId ? { configName: "edge-1" } : null,
      });
      return renderPanel({ api: facade, context: {}, controller });
    };
    return renderToStaticMarkup(react.createElement(Harness));
  };

  it("asks for a session instead of guessing", () => {
    const html = renderReal();
    expect(html).toContain("No active session");
    expect(html).toContain("Overview");
    expect(html).toContain("Groups");
  });

  it("renders the groups view without a session's config", () => {
    const html = renderReal({ activeSessionId: "s1" });
    // The tab bar is there; the empty state names what to do next.
    expect(html).toContain("Overview");
    expect(html).toContain("No groups yet");
  });
});
