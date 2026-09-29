/**
 * File editor close flow: with auto sync off, closing a modified file asks
 * whether to save, like a desktop editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

// Monaco needs a real browser; the close flow only needs something mounted.
vi.mock("../panels/editor/MonacoCodeEditor", () => ({
  default: () => createElement("div", { "data-testid": "code-editor" }),
}));

import { act } from "react";
import FileEditorModal from "../panels/FileEditorModal.jsx";
import { I18nProvider } from "../../lib/i18n.js";
import { installFakeDom, uninstallFakeDom, findElement } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";

const textOf = (node) => (node?.textContent ?? "").toString();
const findButton = (root, label) =>
  findElement(
    root,
    (node) =>
      node.tagName === "BUTTON" &&
      (textOf(node).trim() === label || node.getAttribute?.("aria-label") === label),
  );
// Inside act so the async save and the state it sets settle before asserting.
const click = (root, label) =>
  act(async () => {
    fireClick(findButton(root, label));
  });

async function openEditor(props) {
  const handlers = {
    onClose: vi.fn(),
    onSave: vi.fn(async () => true),
    onDiscard: vi.fn(),
    onFileContentChange: vi.fn(),
  };
  const mounted = await render(
    createElement(
      I18nProvider,
      null,
      createElement(FileEditorModal, {
        open: true,
        filePath: "/etc/nginx/nginx.conf",
        fileContent: "worker_processes 1;",
        dirtyFile: false,
        autoSync: false,
        theme: "light",
        ...handlers,
        ...props,
      }),
    ),
  );
  await act(async () => {});
  return { mounted, ...handlers };
}

const PROMPT = "Save changes to nginx.conf?";

describe("FileEditorModal close flow", () => {
  beforeEach(() => {
    installFakeDom();
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("shows only the file path in the header", async () => {
    const { mounted } = await openEditor();

    const text = textOf(mounted.container);
    expect(text).toContain("/etc/nginx/nginx.conf");
    expect(text).not.toContain("File Editor");

    await mounted.unmount();
  });

  it("closes straight away when there is nothing to save", async () => {
    const { mounted, onClose, onSave } = await openEditor({ dirtyFile: false });

    await click(mounted.container, "Close");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("asks before closing unsaved changes when auto sync is off", async () => {
    const { mounted, onClose } = await openEditor({ dirtyFile: true });

    await click(mounted.container, "Close");

    expect(onClose).not.toHaveBeenCalled();
    expect(textOf(mounted.container)).toContain(PROMPT);
    await mounted.unmount();
  });

  it("saves, then closes, when the user picks Save", async () => {
    const { mounted, onClose, onSave, onDiscard } = await openEditor({ dirtyFile: true });

    await click(mounted.container, "Close");
    await click(mounted.container, "Save");

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it("stays open when the save fails", async () => {
    const { mounted, onClose } = await openEditor({
      dirtyFile: true,
      onSave: vi.fn(async () => false),
    });

    await click(mounted.container, "Close");
    await click(mounted.container, "Save");

    expect(onClose).not.toHaveBeenCalled();
    expect(textOf(mounted.container)).not.toContain(PROMPT);
    await mounted.unmount();
  });

  it("drops the changes and closes when the user picks Don't Save", async () => {
    const { mounted, onClose, onSave, onDiscard } = await openEditor({ dirtyFile: true });

    await click(mounted.container, "Close");
    await click(mounted.container, "Don't Save");

    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it("keeps editing when the user cancels", async () => {
    const { mounted, onClose, onSave, onDiscard } = await openEditor({ dirtyFile: true });

    await click(mounted.container, "Close");
    await click(mounted.container, "Cancel");

    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
    expect(textOf(mounted.container)).not.toContain(PROMPT);
    await mounted.unmount();
  });

  it("flushes the pending save and closes without asking when auto sync is on", async () => {
    const { mounted, onClose, onSave } = await openEditor({ dirtyFile: true, autoSync: true });

    await click(mounted.container, "Close");

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textOf(mounted.container)).not.toContain(PROMPT);
    await mounted.unmount();
  });
});
