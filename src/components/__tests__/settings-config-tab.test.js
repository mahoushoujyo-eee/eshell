/**
 * Settings → Config Files: the manual reload surface.
 *
 * These drive the real component against a fake DOM and a mocked command
 * layer, so the assertions are about what the user sees and which command
 * fires. The outcome wording matters here: a user who hand-edited a file
 * needs to be told whether the change landed, was already in effect, or was
 * rejected because the file is broken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

const commandHandlers = new Map();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    const handler = commandHandlers.get(command);
    if (!handler) {
      throw new Error(`unmocked command in test: ${command}`);
    }
    return handler(args ?? {});
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { act } from "react";
import SettingsModal from "../sidebar/SettingsModal.jsx";
import { I18nProvider } from "../../lib/i18n.js";
import { installFakeDom, uninstallFakeDom, findElement, findElements } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";

const flush = () => act(async () => {});
const textOf = (node) => (node?.textContent ?? "").toString();
const byText = (root, text) =>
  findElement(root, (node) => textOf(node).trim() === text && node.tagName === "BUTTON");

const FILES = [
  { file: "sshConfigs", pathHint: "ssh_configs.json" },
  { file: "acpAgents", pathHint: "acp_agents.json" },
  { file: "scripts", pathHint: "scripts.json" },
];

async function openConfigTab() {
  const mounted = await render(
    createElement(
      I18nProvider,
      null,
      createElement(SettingsModal, {
        open: true,
        onClose: () => {},
        theme: "light",
        onSelectTheme: () => {},
        wallpaperLabel: "none",
        onOpenWallpaperPicker: () => {},
      }),
    ),
  );
  await fireClick(byText(mounted.container, "Config Files"));
  await flush();
  return mounted;
}

describe("Settings Config Files tab", () => {
  beforeEach(() => {
    installFakeDom();
    commandHandlers.clear();
    commandHandlers.set("list_reloadable_configs", async () => FILES);
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("lists every reloadable file with its own Reload button", async () => {
    const mounted = await openConfigTab();

    const text = textOf(mounted.container);
    expect(text).toContain("ssh_configs.json");
    expect(text).toContain("acp_agents.json");
    expect(text).toContain("scripts.json");

    const reloadButtons = findElements(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === "Reload",
    );
    expect(reloadButtons.length).toBe(FILES.length);
    expect(byText(mounted.container, "Reload all")).toBeTruthy();

    await mounted.unmount();
  });

  it("reloads one file and reports that it changed", async () => {
    const calls = [];
    commandHandlers.set("reload_config", async (args) => {
      calls.push(args.input?.file ?? null);
      return [
        {
          file: "sshConfigs",
          path: "/data/ssh_configs.json",
          changed: true,
          missing: false,
          error: null,
        },
      ];
    });

    const mounted = await openConfigTab();
    const first = findElements(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === "Reload",
    )[0];
    await fireClick(first);
    await flush();

    expect(calls).toEqual(["sshConfigs"]);
    expect(textOf(mounted.container)).toContain("Reloaded with changes.");

    await mounted.unmount();
  });

  it("reloads everything when asked", async () => {
    const calls = [];
    commandHandlers.set("reload_config", async (args) => {
      calls.push(args.input?.file ?? null);
      return FILES.map((entry) => ({
        file: entry.file,
        path: `/data/${entry.pathHint}`,
        changed: false,
        missing: false,
        error: null,
      }));
    });

    const mounted = await openConfigTab();
    await fireClick(byText(mounted.container, "Reload all"));
    await flush();

    // `null` in the input is "no file selected", which reloads all.
    expect(calls).toEqual([null]);
    expect(textOf(mounted.container)).toContain("Reloaded, nothing changed.");

    await mounted.unmount();
  });

  it("tells the user a missing file kept its value", async () => {
    commandHandlers.set("reload_config", async () => [
      {
        file: "sshConfigs",
        path: "/data/ssh_configs.json",
        changed: false,
        missing: true,
        error: null,
      },
    ]);

    const mounted = await openConfigTab();
    await fireClick(byText(mounted.container, "Reload all"));
    await flush();

    expect(textOf(mounted.container)).toContain("File not found");

    await mounted.unmount();
  });

  it("names the reason when a file cannot be applied", async () => {
    commandHandlers.set("reload_config", async () => [
      {
        file: "sshConfigs",
        path: "/data/ssh_configs.json",
        changed: false,
        missing: false,
        error: "expected value at line 1 column 1",
      },
    ]);

    const mounted = await openConfigTab();
    await fireClick(byText(mounted.container, "Reload all"));
    await flush();

    const text = textOf(mounted.container);
    expect(text).toContain("Could not apply");
    expect(text).toContain("expected value at line 1 column 1");

    await mounted.unmount();
  });

  it("surfaces a command failure instead of silent success", async () => {
    commandHandlers.set("reload_config", async () => {
      throw new Error("unknown config file \"nope\"");
    });

    const mounted = await openConfigTab();
    await fireClick(byText(mounted.container, "Reload all"));
    await flush();

    expect(textOf(mounted.container)).toContain("unknown config file");

    await mounted.unmount();
  });

  it("says reloading does not restart sessions", async () => {
    const mounted = await openConfigTab();

    // The pane must not imply that reload == reconnect.
    expect(textOf(mounted.container)).toContain("does not restart anything");

    await mounted.unmount();
  });
});
