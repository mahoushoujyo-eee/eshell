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
import { listPlugins, listPanelContributions } from "../registry";

describe("registerBuiltinPlugins", () => {
  it("registers both builtin plugins in manifest order, exactly once", () => {
    registerBuiltinPlugins();
    registerBuiltinPlugins(); // second call must be a no-op
    const ids = listPlugins().map((plugin) => plugin.id);
    const sftpIndex = ids.indexOf(SFTP_EXTENSION_ID);
    const statusIndex = ids.indexOf(STATUS_EXTENSION_ID);
    expect(sftpIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(sftpIndex);
    expect(ids.filter((id) => id === SFTP_EXTENSION_ID)).toHaveLength(1);
    expect(ids.filter((id) => id === STATUS_EXTENSION_ID)).toHaveLength(1);
  });

  it("contributes the sftp panel at order 10 and status at 20", () => {
    registerBuiltinPlugins();
    const panels = listPanelContributions();
    expect(panels).toHaveLength(2);
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
  });

  it("exposes renderable panel components", () => {
    registerBuiltinPlugins();
    const panels = listPanelContributions();
    expect(panels.every((panel) => typeof panel.render === "function")).toBe(true);
  });
});
