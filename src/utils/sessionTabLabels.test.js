import { describe, expect, it } from "vitest";
import { sessionTabLabels } from "./sessionTabLabels";

describe("sessionTabLabels", () => {
  it("uses the profile name when it is unique", () => {
    const labels = sessionTabLabels([
      { id: "a", configName: "prod" },
      { id: "b", configName: "db" },
    ]);
    expect(labels.get("a")).toBe("prod");
    expect(labels.get("b")).toBe("db");
  });

  it("numbers only the duplicated names, in tab order", () => {
    const labels = sessionTabLabels([
      { id: "a", configName: "prod" },
      { id: "b", configName: "db" },
      { id: "c", configName: "prod" },
    ]);
    expect(labels.get("a")).toBe("prod #1");
    expect(labels.get("b")).toBe("db");
    expect(labels.get("c")).toBe("prod #2");
  });

  it("returns an empty map for a missing list", () => {
    expect(sessionTabLabels(undefined).size).toBe(0);
  });
});
