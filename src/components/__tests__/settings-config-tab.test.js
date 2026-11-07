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
// The editor itself is Monaco, which the fake DOM cannot host. Stand in for it
// with the smallest component that reproduces the contract the tab relies on:
// it shows the text it was given, surfaces the error prop, and can trigger a
// save.
vi.mock("../panels/file-editor-loader", () => ({
  loadFileEditorModal: async () => {
    const React = await import("react");
    // React.lazy resolves a module, so the stub has to arrive as `default`.
    return {
      default: function StubEditor(props) {
        return React.createElement(
          "div",
          { class: "stub-editor" },
          React.createElement("span", { class: "stub-editor-content" }, props.fileContent),
          props.error
            ? React.createElement("span", { class: "stub-editor-error" }, props.error)
            : null,
          React.createElement(
            "button",
            { type: "button", onClick: () => props.onSave() },
            "editor-save",
          ),
        );
      },
    };
  },
}));

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

  it("opens a config file in the editor and saves it back", async () => {
    const reads = [];
    const writes = [];
    commandHandlers.set("read_config_file", async (args) => {
      reads.push(args.input?.file);
      return {
        file: "acpAgents",
        path: "/data/acp_agents.json",
        exists: true,
        content: '{"agents":[]}',
      };
    });
    commandHandlers.set("write_config_file", async (args) => {
      writes.push(args.input);
      return {
        file: args.input.file,
        path: "/data/acp_agents.json",
        changed: true,
        missing: false,
        error: null,
      };
    });

    const mounted = await openConfigTab();
    // Rows are ssh, acpAgents, scripts: the second Edit belongs to the ACP file.
    const editButtons = findElements(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === "Edit",
    );
    expect(editButtons.length).toBe(FILES.length);
    await fireClick(editButtons[1]);
    await flush();

    expect(reads).toEqual(["acpAgents"]);
    expect(textOf(mounted.container)).toContain('{"agents":[]}');

    const save = findElement(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === "editor-save",
    );
    await fireClick(save);
    await flush();

    expect(writes).toEqual([{ file: "acpAgents", content: '{"agents":[]}' }]);
    expect(textOf(mounted.container)).toContain("Saved and applied.");

    await mounted.unmount();
  });

  it("keeps the editor open and explains a rejected save", async () => {
    commandHandlers.set("read_config_file", async () => ({
      file: "acpAgents",
      path: "/data/acp_agents.json",
      exists: true,
      content: "{}",
    }));
    commandHandlers.set("write_config_file", async () => {
      throw new Error("expected value at line 1 column 1");
    });

    const mounted = await openConfigTab();
    const editButtons = findElements(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === "Edit",
    );
    await fireClick(editButtons[1]);
    await flush();

    const save = findElement(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === "editor-save",
    );
    await fireClick(save);
    await flush();

    const text = textOf(mounted.container);
    expect(text).toContain("expected value at line 1 column 1");
    // The editor is still mounted, so the user can fix the typo instead of
    // losing what they typed.
    expect(text).toContain("{}");
    expect(text).not.toContain("Saved and applied.");

    await mounted.unmount();
  });
});
