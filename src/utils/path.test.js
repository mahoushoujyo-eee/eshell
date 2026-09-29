import { describe, expect, it } from "vitest";

import { parentRemotePath, renameRemoteEntryPath } from "./path";

describe("parentRemotePath", () => {
  it("strips the last segment", () => {
    expect(parentRemotePath("/var/www/app")).toBe("/var/www");
    expect(parentRemotePath("/var")).toBe("/");
  });

  it("treats root as its own parent", () => {
    expect(parentRemotePath("/")).toBe("/");
    expect(parentRemotePath("")).toBe("/");
  });

  it("normalizes the path before walking up", () => {
    expect(parentRemotePath("var/www/")).toBe("/var");
    expect(parentRemotePath("//var///www")).toBe("/var");
  });
});

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
