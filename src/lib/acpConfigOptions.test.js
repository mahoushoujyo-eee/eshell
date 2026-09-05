import { describe, expect, it } from "vitest";

import {
  configOptionCurrentLabel,
  configSelectGroups,
  configSelectValues,
  visibleConfigOptions,
} from "./acpConfigOptions";

// Captured with `node scripts/acp-probe.mjs` against the real agents.
const CODEX_OPTIONS = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "agent",
    options: [
      { value: "read-only", name: "Ask for approval" },
      { value: "agent", name: "Approve for me" },
      { value: "agent-full-access", name: "Full access" },
    ],
  },
  {
    id: "collaboration_mode",
    name: "Collaboration mode",
    category: "collaboration_mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.6-luna",
    options: [
      { value: "gpt-6-astra", name: "GPT-6-Astra" },
      { value: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "xhigh",
    options: [
      { value: "low", name: "Low" },
      { value: "xhigh", name: "Xhigh" },
    ],
  },
  {
    id: "fast-mode",
    name: "Fast mode",
    category: "model_config",
    type: "select",
    currentValue: "off",
    options: [
      { value: "off", name: "Off" },
      { value: "on", name: "On" },
    ],
  },
];

// Claude Code's persona selector arrives with no category at all.
const CLAUDE_UNCATEGORIZED = {
  id: "agent",
  name: "Agent",
  type: "select",
  currentValue: "default",
  options: [{ value: "default", name: "Default" }],
};

describe("visibleConfigOptions", () => {
  it("shows model then thought level, in that order", () => {
    const visible = visibleConfigOptions(CODEX_OPTIONS);
    expect(visible.map((option) => option.id)).toEqual(["model", "reasoning_effort"]);
  });

  it("drops fast mode, whichever agent advertises it", () => {
    // Codex labels it `fast-mode`; Claude Code offers the same model_config
    // option when an Opus model is selected. Neither should reach the menu.
    expect(visibleConfigOptions(CODEX_OPTIONS).map((o) => o.id)).not.toContain("fast-mode");
    expect(
      visibleConfigOptions([
        { id: "fast-mode", name: "Fast mode", category: "model_config", type: "select",
          currentValue: "off", options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
      ]),
    ).toEqual([]);
  });

  it("drops the mode mirror, since session/set_mode already drives it", () => {
    expect(visibleConfigOptions(CODEX_OPTIONS).map((o) => o.id)).not.toContain("mode");
  });

  it("drops unknown and absent categories", () => {
    // Codex's collaboration_mode (non-spec category) and Claude Code's
    // uncategorized persona selector both stay out of the menu.
    const visible = visibleConfigOptions([CLAUDE_UNCATEGORIZED, ...CODEX_OPTIONS]);
    expect(visible.map((option) => option.id)).not.toContain("agent");
    expect(visible.map((option) => option.id)).not.toContain("collaboration_mode");
  });

  it("preserves the agent's own order within one category", () => {
    const visible = visibleConfigOptions([
      { id: "z", category: "model", type: "boolean", currentValue: false },
      { id: "a", category: "model", type: "boolean", currentValue: true },
    ]);
    expect(visible.map((option) => option.id)).toEqual(["z", "a"]);
  });

  it("tolerates junk", () => {
    expect(visibleConfigOptions(null)).toEqual([]);
    expect(visibleConfigOptions([null, {}, { id: "" }])).toEqual([]);
  });
});

describe("configSelectGroups", () => {
  it("wraps a flat list in one unnamed group", () => {
    const groups = configSelectGroups(CODEX_OPTIONS[2]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBeNull();
    expect(groups[0].options.map((v) => v.value)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
  });

  it("passes grouped options through", () => {
    const groups = configSelectGroups({
      options: [
        { group: "g1", name: "Fast", options: [{ value: "a", name: "A" }] },
        { group: "g2", name: "Slow", options: [{ value: "b", name: "B" }] },
      ],
    });
    expect(groups.map((g) => g.name)).toEqual(["Fast", "Slow"]);
    expect(configSelectValues({
      options: [
        { group: "g1", name: "Fast", options: [{ value: "a", name: "A" }] },
        { group: "g2", name: "Slow", options: [{ value: "b", name: "B" }] },
      ],
    }).map((v) => v.value)).toEqual(["a", "b"]);
  });

  it("returns nothing for boolean options or junk", () => {
    expect(configSelectGroups({ type: "boolean", currentValue: true })).toEqual([]);
    expect(configSelectGroups(null)).toEqual([]);
  });
});

describe("configOptionCurrentLabel", () => {
  it("resolves a select value to its display name", () => {
    expect(configOptionCurrentLabel(CODEX_OPTIONS[2])).toBe("GPT-5.6-Luna");
    expect(configOptionCurrentLabel(CODEX_OPTIONS[3])).toBe("Xhigh");
  });

  it("falls back to the raw value when the agent reports one not in the list", () => {
    expect(
      configOptionCurrentLabel({ type: "select", currentValue: "glm-5.3-flash[1M]", options: [] }),
    ).toBe("glm-5.3-flash[1M]");
  });

  it("labels booleans", () => {
    expect(configOptionCurrentLabel({ type: "boolean", currentValue: true })).toBe("On");
    expect(configOptionCurrentLabel({ type: "boolean", currentValue: false })).toBe("Off");
  });

  it("tolerates junk", () => {
    expect(configOptionCurrentLabel(null)).toBe("");
  });
});
