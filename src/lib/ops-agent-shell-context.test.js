import { describe, expect, it } from "vitest";

import {
  SHELL_CONTEXT_MAX_CHARS,
  createShellContextAttachment,
  formatShellContextPreview,
  normalizeShellContextAttachment,
  normalizeShellContextContent,
} from "./ops-agent-shell-context";

describe("normalizeShellContextContent", () => {
  it("returns null for empty values", () => {
    expect(normalizeShellContextContent("   ")).toBeNull();
    expect(normalizeShellContextContent(null)).toBeNull();
  });

  it("trims and truncates shell context", () => {
    const raw = `  ${"x".repeat(SHELL_CONTEXT_MAX_CHARS + 20)}  `;
    const normalized = normalizeShellContextContent(raw);

    expect(normalized.endsWith("...")).toBe(true);
    expect(normalized.length).toBe(SHELL_CONTEXT_MAX_CHARS + 3);
  });
});

describe("formatShellContextPreview", () => {
  it("collapses whitespace for tag display", () => {
    expect(formatShellContextPreview("line1\n\nline2\tvalue")).toBe("line1 line2 value");
  });
});

describe("createShellContextAttachment", () => {
  it("builds a reusable shell context payload", () => {
    expect(
      createShellContextAttachment({
        sessionId: "session-1",
        sessionName: "Prod",
        content: "systemctl status nginx",
      }),
    ).toEqual({
      sessionId: "session-1",
      sessionName: "Prod",
      content: "systemctl status nginx",
      preview: "systemctl status nginx",
      charCount: 22,
    });
  });
});

describe("normalizeShellContextAttachment", () => {
  it("rebuilds preview fields for deserialized message payloads", () => {
    expect(
      normalizeShellContextAttachment({
        sessionId: " session-1 ",
        sessionName: " Prod ",
        content: "line1\n\nline2",
        preview: "",
        charCount: 0,
      }),
    ).toEqual({
      sessionId: "session-1",
      sessionName: "Prod",
      content: "line1\n\nline2",
      preview: "line1 line2",
      charCount: 12,
    });
  });
});
