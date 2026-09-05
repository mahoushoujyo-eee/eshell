import { describe, expect, it } from "vitest";

import {
  ACP_AGENT_BRANDS,
  formatAcpAgentSpawn,
  getAcpAgentBrand,
  resolveAcpAgentBrandKey,
} from "./acpAgentBrands";

// Mirrors the defaults documented in the ACP agent guide (and written to
// .eshell-data/acp_agents.json), including the Windows cmd shim.
const agent = (id, name, command, args) => ({ id, name, command, args });

describe("resolveAcpAgentBrandKey", () => {
  it("maps the documented agents to their brand", () => {
    expect(
      resolveAcpAgentBrandKey(
        agent("codex", "Codex", "cmd", ["/c", "npx", "-y", "@agentclientprotocol/codex-acp"]),
      ),
    ).toBe("openai");
    expect(
      resolveAcpAgentBrandKey(
        agent("claude", "Claude Code", "cmd", [
          "/c",
          "npx",
          "-y",
          "@agentclientprotocol/claude-agent-acp",
        ]),
      ),
    ).toBe("claude");
    expect(
      resolveAcpAgentBrandKey(
        agent("opencode", "OpenCode", "cmd", ["/c", "npx", "-y", "opencode-ai", "acp"]),
      ),
    ).toBe("opencode");
    expect(
      resolveAcpAgentBrandKey(agent("gemini", "Gemini CLI", "gemini", ["--experimental-acp"])),
    ).toBe("gemini");
    expect(resolveAcpAgentBrandKey(agent("qwen", "Qwen Code", "qwen", ["--experimental-acp"]))).toBe(
      "qwen",
    );
  });

  it("falls back to the spawn command for renamed agents", () => {
    expect(
      resolveAcpAgentBrandKey(agent("work", "Work Bot", "npx", ["-y", "opencode-ai", "acp"])),
    ).toBe("opencode");
  });

  it("prefers the agent identity over the spawn command", () => {
    // A Claude Code agent launched through a wrapper that mentions codex must
    // still show the Claude mark.
    expect(
      resolveAcpAgentBrandKey(agent("claude", "Claude Code", "sh", ["./codex-wrapper.sh"])),
    ).toBe("claude");
  });

  it("does not confuse OpenCode with OpenAI", () => {
    expect(resolveAcpAgentBrandKey(agent("opencode", "OpenCode", "opencode", ["acp"]))).toBe(
      "opencode",
    );
  });

  it("returns null for unknown and malformed agents", () => {
    expect(resolveAcpAgentBrandKey(agent("mine", "My Agent", "node", ["server.js"]))).toBeNull();
    expect(resolveAcpAgentBrandKey(null)).toBeNull();
    expect(resolveAcpAgentBrandKey({})).toBeNull();
  });
});

describe("getAcpAgentBrand", () => {
  it("returns renderable metadata for every known brand", () => {
    for (const key of Object.keys(ACP_AGENT_BRANDS)) {
      const brand = getAcpAgentBrand(agent(key, key, key, []));
      expect(brand).toMatchObject({ key });
      expect(brand.path.length).toBeGreaterThan(0);
      expect(brand.label.length).toBeGreaterThan(0);
      expect(brand.markClass.length).toBeGreaterThan(0);
      expect(brand.chipClass.length).toBeGreaterThan(0);
    }
  });

  it("returns null when the brand is unknown", () => {
    expect(getAcpAgentBrand(agent("mine", "My Agent", "node", []))).toBeNull();
  });
});

describe("formatAcpAgentSpawn", () => {
  it("joins the command and args", () => {
    expect(formatAcpAgentSpawn(agent("gemini", "Gemini CLI", "gemini", ["--experimental-acp"]))).toBe(
      "gemini --experimental-acp",
    );
  });

  it("tolerates missing args and missing agents", () => {
    expect(formatAcpAgentSpawn({ command: "codex-acp" })).toBe("codex-acp");
    expect(formatAcpAgentSpawn(null)).toBe("");
  });
});
