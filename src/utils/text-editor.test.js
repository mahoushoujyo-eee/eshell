import { describe, expect, it } from "vitest";

import { applyEditorTab } from "./text-editor";

describe("applyEditorTab", () => {
  it("inserts indentation at the cursor instead of moving focus", () => {
    expect(applyEditorTab("apiVersion:", 3, 3)).toEqual({
      value: "api  Version:",
      selectionStart: 5,
      selectionEnd: 5,
    });
  });

  it("indents every selected line", () => {
    expect(applyEditorTab("one\ntwo\nthree", 1, 8)).toEqual({
      value: "  one\n  two\nthree",
      selectionStart: 1,
      selectionEnd: 12,
    });
  });
});
