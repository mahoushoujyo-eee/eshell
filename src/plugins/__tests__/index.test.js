import { describe, expect, it } from "vitest";
import { registerBuiltinPlugins } from "../index.jsx";
import {
  STATUS_EXTENSION_ID,
  STATUS_PANEL_ID,
} from "../status/index.jsx";
import {
  SFTP_EXTENSION_ID,
  SFTP_PANEL_ID,
} from "../sftp/index.jsx";
import {
  FORWARD_EXTENSION_ID,
  FORWARD_PANEL_ID,
} from "../forward/index.jsx";
import { listPlugins, listPanelContributions } from "../registry";

describe("registerBuiltinPlugins", () => {
  it("registers every builtin plugin in manifest order, exactly once", () => {
    registerBuiltinPlugins();
    registerBuiltinPlugins(); // second call must be a no-op
    const ids = listPlugins().map((plugin) => plugin.id);
    const sftpIndex = ids.indexOf(SFTP_EXTENSION_ID);
    const statusIndex = ids.indexOf(STATUS_EXTENSION_ID);
    const forwardIndex = ids.indexOf(FORWARD_EXTENSION_ID);
    expect(sftpIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(sftpIndex);
    expect(forwardIndex).toBeGreaterThan(statusIndex);
    for (const id of [SFTP_EXTENSION_ID, STATUS_EXTENSION_ID, FORWARD_EXTENSION_ID]) {
      expect(ids.filter((entry) => entry === id)).toHaveLength(1);
    }
  });

  it("contributes sftp at 10, status at 20 and forward at 30", () => {
    registerBuiltinPlugins();
    const panels = listPanelContributions();
    expect(panels).toHaveLength(3);
    expect(panels[0]).toMatchObject({
      pluginId: SFTP_EXTENSION_ID,
      id: SFTP_PANEL_ID,
      order: 10,
      key: "sftp",
    });
    expect(panels[1]).toMatchObject({
      pluginId: STATUS_EXTENSION_ID,
      id: STATUS_PANEL_ID,
      order: 20,
      key: "status",
    });
    expect(panels[2]).toMatchObject({
      pluginId: FORWARD_EXTENSION_ID,
      id: FORWARD_PANEL_ID,
      order: 30,
      key: "forward",
    });
  });

  it("exposes renderable panel components", () => {
    registerBuiltinPlugins();
    const panels = listPanelContributions();
    expect(panels.every((panel) => typeof panel.render === "function")).toBe(true);
  });
});
