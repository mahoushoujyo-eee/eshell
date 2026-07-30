import { describe, expect, it } from "vitest";
import {
  buildAiImportProfileForm,
  describeAiImportSource,
  isAiImportCandidateReady,
  normalizeAiImportCandidate,
  normalizeAiImportCandidates,
  normalizeAiImportSource,
  normalizeAiImportSources,
  normalizeAiImportSourceKind,
} from "./aiImport";

const sampleSource = {
  id: "claude:/Users/me/.claude/settings.json",
  kind: "claude_code",
  label: "Claude Code",
  path: "/Users/me/.claude/settings.json",
  available: true,
  note: null,
};

const sampleCandidate = {
  sourceId: "claude:/Users/me/.claude/settings.json",
  sourceKind: "claude_code",
  sourceLabel: "Claude Code",
  sourcePath: "/Users/me/.claude/settings.json",
  name: "Claude (claude-sonnet-5)",
  apiType: "anthropic_messages",
  baseUrl: "https://athenai.example.com",
  apiKey: "sk-test",
  model: "claude-sonnet-5",
  temperature: 0.3,
  maxTokens: 1024,
  maxContextTokens: 80000,
  systemPrompt: "You are helpful.",
  notes: ["example"],
};

describe("normalizeAiImportSourceKind", () => {
  it("accepts known kinds", () => {
    expect(normalizeAiImportSourceKind("claude_code")).toBe("claude_code");
    expect(normalizeAiImportSourceKind("codex")).toBe("codex");
    expect(normalizeAiImportSourceKind("custom_json")).toBe("custom_json");
  });

  it("falls back to custom_json for unknown values", () => {
    expect(normalizeAiImportSourceKind("not-a-kind")).toBe("custom_json");
    expect(normalizeAiImportSourceKind(null)).toBe("custom_json");
  });
});

describe("normalizeAiImportSource", () => {
  it("returns null for falsy input", () => {
    expect(normalizeAiImportSource(null)).toBeNull();
    expect(normalizeAiImportSource(undefined)).toBeNull();
  });

  it("normalizes valid sources", () => {
    const normalized = normalizeAiImportSource(sampleSource);
    expect(normalized.kind).toBe("claude_code");
    expect(normalized.path).toBe(sampleSource.path);
    expect(normalized.available).toBe(true);
    expect(normalized.note).toBeNull();
  });

  it("preserves unavailable note when present", () => {
    const normalized = normalizeAiImportSource({
      ...sampleSource,
      available: false,
      note: "missing",
    });
    expect(normalized.available).toBe(false);
    expect(normalized.note).toBe("missing");
  });
});

describe("normalizeAiImportSources", () => {
  it("filters out null entries", () => {
    const list = [sampleSource, null];
    const normalized = normalizeAiImportSources(list);
    expect(normalized.length).toBe(1);
    expect(normalized[0].id).toBe(sampleSource.id);
  });
});

describe("normalizeAiImportCandidate", () => {
  it("returns null for non-object input", () => {
    expect(normalizeAiImportCandidate(null)).toBeNull();
    expect(normalizeAiImportCandidate("foo")).toBeNull();
  });

  it("coerces invalid api types to the default", () => {
    const normalized = normalizeAiImportCandidate({
      ...sampleCandidate,
      apiType: "something-else",
    });
    expect(normalized.apiType).toBe("openai_chat_completions");
  });

  it("rounds numeric fields and falls back to defaults", () => {
    const normalized = normalizeAiImportCandidate({
      ...sampleCandidate,
      temperature: "0.4",
      maxTokens: "999.5",
      maxContextTokens: "0",
    });
    expect(normalized.temperature).toBe(0.4);
    expect(normalized.maxTokens).toBe(1000);
    expect(normalized.maxContextTokens).toBe(1);
  });
});

describe("normalizeAiImportCandidates", () => {
  it("handles non-array input", () => {
    expect(normalizeAiImportCandidates(undefined)).toEqual([]);
    expect(normalizeAiImportCandidates(null)).toEqual([]);
  });
});

describe("buildAiImportProfileForm", () => {
  it("builds a default form when input is missing", () => {
    const form = buildAiImportProfileForm(null);
    expect(form.apiType).toBe("openai_chat_completions");
    expect(form.baseUrl).toBe("");
    expect(form.notes).toEqual([]);
  });

  it("merges candidate values into the form", () => {
    const form = buildAiImportProfileForm(sampleCandidate);
    expect(form.name).toBe(sampleCandidate.name);
    expect(form.apiType).toBe("anthropic_messages");
    expect(form.apiKey).toBe("sk-test");
    expect(form.model).toBe("claude-sonnet-5");
    expect(form.sourceId).toBe(sampleCandidate.sourceId);
    expect(form.sourceKind).toBe("claude_code");
  });

  it("preserves all required fields when caller passes only edited values", () => {
    const partialEdit = { name: "Renamed", apiType: "openai_responses" };
    const merged = { ...sampleCandidate, ...partialEdit };
    const form = buildAiImportProfileForm(merged);
    expect(form.name).toBe("Renamed");
    expect(form.apiType).toBe("openai_responses");
    expect(form.apiKey).toBe("sk-test");
    expect(form.baseUrl).toBe("https://athenai.example.com");
    expect(form.model).toBe("claude-sonnet-5");
    expect(form.sourceId).toBe(sampleCandidate.sourceId);
  });
});

describe("isAiImportCandidateReady", () => {
  it("requires baseUrl and model", () => {
    expect(isAiImportCandidateReady({ baseUrl: "x", model: "y" })).toBe(true);
    expect(isAiImportCandidateReady({ baseUrl: "x", model: "" })).toBe(false);
    expect(isAiImportCandidateReady({ baseUrl: "", model: "y" })).toBe(false);
    expect(isAiImportCandidateReady(null)).toBe(false);
  });
});

describe("describeAiImportSource", () => {
  it("returns human-friendly kind label and path", () => {
    const description = describeAiImportSource(sampleSource);
    expect(description.kindLabel).toBe("Claude Code");
    expect(description.pathLabel).toBe(sampleSource.path);
    expect(description.available).toBe(true);
  });

  it("handles invalid input gracefully", () => {
    const description = describeAiImportSource(null);
    expect(description.kindLabel).toBe("");
    expect(description.available).toBe(false);
  });
});
