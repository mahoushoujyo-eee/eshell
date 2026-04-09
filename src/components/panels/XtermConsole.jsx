import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getTerminalWallpaperStyle, normalizeWallpaperSelection } from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";
import { normalizeShellContextContent } from "../../lib/ops-agent-shell-context";
import XtermSelectionAction from "./xterm/XtermSelectionAction";

const inputFlushDelayMs = 18;
const transparentTerminalBackground = "rgba(0, 0, 0, 0)";

export default function XtermConsole({
  activeSessionId,
  activeSessionName,
  output,
  onInput,
  onResize,
  onAttachSelection,
  wallpaper,
}) {
  const { t } = useI18n();
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const renderedLengthRef = useRef(0);
  const renderedSessionIdRef = useRef(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const activeSessionNameRef = useRef(activeSessionName);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onAttachSelectionRef = useRef(onAttachSelection);
  const pendingInputRef = useRef("");
  const flushTimerRef = useRef(null);
  const [selectionText, setSelectionText] = useState("");
  const normalizedWallpaper = useMemo(() => normalizeWallpaperSelection(wallpaper), [wallpaper]);
  const wallpaperStyle = useMemo(() => getTerminalWallpaperStyle(normalizedWallpaper), [normalizedWallpaper]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeSessionNameRef.current = activeSessionName;
  }, [activeSessionName]);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onAttachSelectionRef.current = onAttachSelection;
  }, [onAttachSelection]);

  useEffect(() => {
    setSelectionText("");
  }, [activeSessionId]);

  useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const term = new Xterm({
      cursorBlink: true,
      convertEol: false,
      scrollback: 8_000,
      fontSize: 13,
      lineHeight: 1.28,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      allowTransparency: true,
      theme: {
        foreground: "#d6f6dc",
        background: transparentTerminalBackground,
        cursor: "#d6f6dc",
        selectionBackground: "rgba(90, 166, 134, 0.34)",
      },
    });
    const fitAddon = new FitAddon();

    term.loadAddon(fitAddon);
    term.open(hostRef.current);
    term.focus();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const flushInput = () => {
      flushTimerRef.current = null;
      if (!pendingInputRef.current) {
        return;
      }
      const data = pendingInputRef.current;
      pendingInputRef.current = "";
      const sessionId = activeSessionIdRef.current;
      if (sessionId) {
        onInputRef.current?.(sessionId, data);
      }
    };

    const queueInput = (chunk) => {
      if (!activeSessionIdRef.current) {
        return;
      }
      pendingInputRef.current += chunk;
      if (!flushTimerRef.current) {
        flushTimerRef.current = window.setTimeout(flushInput, inputFlushDelayMs);
      }
    };

    const fitTerminal = () => {
      try {
        fitAddon.fit();
        const sessionId = activeSessionIdRef.current;
        if (sessionId && term.cols > 0 && term.rows > 0) {
          onResizeRef.current?.(sessionId, term.cols, term.rows);
        }
      } catch (_err) {
        // Ignore transient layout errors during mount / resize races.
      }
    };

    const dataDisposable = term.onData(queueInput);
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const sessionId = activeSessionIdRef.current;
      if (sessionId && cols > 0 && rows > 0) {
        onResizeRef.current?.(sessionId, cols, rows);
      }
    });
    const selectionDisposable = term.onSelectionChange(() => {
      setSelectionText(normalizeShellContextContent(term.getSelection()) || "");
    });

    fitTerminal();

    const observer = new ResizeObserver(() => {
      fitTerminal();
    });
    observer.observe(hostRef.current);
    resizeObserverRef.current = observer;
    window.addEventListener("resize", fitTerminal);

    return () => {
      window.removeEventListener("resize", fitTerminal);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      term.dispose();
      fitAddonRef.current = null;
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }

    const isSessionChanged = renderedSessionIdRef.current !== activeSessionId;
    if (isSessionChanged) {
      term.reset();
      renderedSessionIdRef.current = activeSessionId;
      renderedLengthRef.current = 0;
      if (!activeSessionId) {
        term.writeln(`\x1b[38;5;245m${t("No active sessions")}\x1b[0m`);
      } else if (!output) {
        term.writeln(`\x1b[38;5;245m${t("PTY connected. Type directly in terminal.")}\x1b[0m`);
      }
      setSelectionText("");
      if (activeSessionId && term.cols > 0 && term.rows > 0) {
        onResizeRef.current?.(activeSessionId, term.cols, term.rows);
      }
    }

    if (!activeSessionId || !output) {
      return;
    }

    if (output.length < renderedLengthRef.current) {
      term.reset();
      renderedLengthRef.current = 0;
    }

    const delta = output.slice(renderedLengthRef.current);
    if (!delta) {
      return;
    }

    term.write(delta);
    renderedLengthRef.current = output.length;
    term.scrollToBottom();
  }, [activeSessionId, output]);

  const handleAttachSelection = () => {
    const term = termRef.current;
    if (!term || !selectionText || !activeSessionIdRef.current) {
      return;
    }

    onAttachSelectionRef.current?.({
      sessionId: activeSessionIdRef.current,
      sessionName: activeSessionNameRef.current || "Shell",
      content: selectionText,
    });
    term.clearSelection();
    setSelectionText("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-hidden p-2 pb-3">
      <div className="terminal-frame relative h-full w-full overflow-hidden border border-black/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        {selectionText ? (
          <XtermSelectionAction
            selectionLength={Array.from(selectionText).length}
            onClick={handleAttachSelection}
          />
        ) : null}
        <div
          ref={hostRef}
          className={[
            "terminal-host relative h-full w-full",
            normalizedWallpaper.glass ? "terminal-host--glass" : "",
          ].join(" ")}
          style={wallpaperStyle}
        />
      </div>
    </div>
  );
}
