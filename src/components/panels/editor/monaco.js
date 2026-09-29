import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/register.all";
import "monaco-editor/languages/features/css/register";
import "monaco-editor/languages/features/html/register";
import "monaco-editor/languages/features/json/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

// The TypeScript language service is left out on purpose: its worker is
// several MB and remote scripts only need the syntax highlighting that the
// language definitions already provide.
const WORKER_BY_LABEL = {
  json: JsonWorker,
  css: CssWorker,
  scss: CssWorker,
  less: CssWorker,
  html: HtmlWorker,
  handlebars: HtmlWorker,
  razor: HtmlWorker,
};

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    const Worker = WORKER_BY_LABEL[label] || EditorWorker;
    return new Worker();
  },
};

// Use the bundled instance; the default loader fetches Monaco from a CDN.
loader.config({ monaco });

// Hex copies of the `--es-*` tokens in index.css (Monaco themes cannot read
// CSS variables); keep them in sync.
const PALETTES = {
  light: {
    base: "vs",
    panel: "#ffffff",
    elevated: "#ffffff",
    text: "#151a25",
    muted: "#5b6478",
    subtle: "#8a92a5",
    border: "#dde2ea",
    borderStrong: "#c5ccd8",
    accent: "#0b7a54",
    hover: "#151a250e",
  },
  dark: {
    base: "vs-dark",
    panel: "#191e2b",
    elevated: "#212839",
    text: "#e3e7f0",
    muted: "#8a93a9",
    subtle: "#6b7389",
    border: "#262d3f",
    borderStrong: "#353d54",
    accent: "#3dd68c",
    hover: "#ffffff0d",
  },
};

for (const [name, palette] of Object.entries(PALETTES)) {
  monaco.editor.defineTheme(`eshell-${name}`, {
    base: palette.base,
    inherit: true,
    rules: [],
    colors: {
      focusBorder: `${palette.accent}99`,
      "editor.background": palette.panel,
      "editor.foreground": palette.text,
      "editorGutter.background": palette.panel,
      "editorLineNumber.foreground": palette.subtle,
      "editorLineNumber.activeForeground": palette.muted,
      "editorCursor.foreground": palette.accent,
      "editor.lineHighlightBackground": palette.hover,
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": `${palette.accent}33`,
      "editor.inactiveSelectionBackground": `${palette.accent}1f`,
      "editorIndentGuide.background1": palette.border,
      "editorIndentGuide.activeBackground1": palette.borderStrong,
      "editorWidget.background": palette.elevated,
      "editorWidget.border": palette.border,
      "editorSuggestWidget.background": palette.elevated,
      "editorSuggestWidget.border": palette.border,
    },
  });
}

export function monacoThemeFor(theme) {
  return theme === "dark" ? "eshell-dark" : "eshell-light";
}
