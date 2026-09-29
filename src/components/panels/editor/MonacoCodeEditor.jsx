import Editor from "@monaco-editor/react";
import { useCallback, useRef } from "react";
import { monacoThemeFor } from "./monaco";

const EDITOR_OPTIONS = {
  automaticLayout: true,
  // The dialog clips overflow; let hovers and suggestions escape it.
  fixedOverflowWidgets: true,
  // Mirrors `--font-mono` in index.css: Monaco measures glyphs from this
  // string, so a CSS variable would not resolve.
  fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
  fontSize: 13,
  tabSize: 2,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: "selection",
  padding: { top: 12, bottom: 12 },
  // Otherwise full-width CJK punctuation in comments gets boxed as "ambiguous".
  unicodeHighlight: { ambiguousCharacters: false },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
};

export default function MonacoCodeEditor({ value, language, theme, onChange, onSave, loading }) {
  // Monaco keeps the command it was mounted with; read the latest handler.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.());
    editor.focus();
  }, []);

  return (
    <Editor
      value={value}
      language={language}
      theme={monacoThemeFor(theme)}
      options={EDITOR_OPTIONS}
      loading={loading}
      onMount={handleMount}
      onChange={(next) => onChange(next ?? "")}
    />
  );
}
