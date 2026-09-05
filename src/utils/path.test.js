import { describe, expect, it } from "vitest";

import { renameRemoteEntryPath } from "./path";

describe("renameRemoteEntryPath", () => {
  it("keeps the renamed entry in its original parent directory", () => {
    expect(renameRemoteEntryPath("/var/www/app/config.toml", "settings.toml")).toBe(
      "/var/www/app/settings.toml",
    );
  });

  it("rejects root paths and nested names", () => {
    expect(renameRemoteEntryPath("/", "root")).toBeNull();
    expect(renameRemoteEntryPath("/var/www/app/config.toml", "../settings.toml")).toBeNull();
    expect(renameRemoteEntryPath("/var/www/app/config.toml", "nested/settings.toml")).toBeNull();
  });
});
