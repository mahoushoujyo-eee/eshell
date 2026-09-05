import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { Loader2, RotateCcw, WifiOff } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { getTerminalWallpaperStyle, normalizeWallpaperSelection } from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";
import { normalizeShellContextContent } from "../../lib/ops-agent-shell-context";
import { recordTerminalResize, recordXtermWrite, recordPtyChunk } from "../../lib/terminal-perf-debug";
import XtermSelectionAction from "./xterm/XtermSelectionAction";

const transparentTerminalBackground = "rgba(0, 0, 0, 0)";

// Full-frame overlay shown when the session's PTY died: explains that the
// terminal is no longer interactive and offers a reconnect.
function XtermDisconnectOverlay({ reason, onReconnect }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleReconnect = async () => {
    if (!onReconnect || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onReconnect();
    } catch (err) {
      setError(typeof err === "string" ? err : err?.message || String(err));
      setBusy(false);
    }
    // On success the session id changes and this overlay unmounts.
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center backdrop-blur-[2px]">
      <WifiOff className="h-8 w-8 text-red-400" aria-hidden="true" />
      <div className="text-sm font-semibold text-white">{t("Session disconnected")}</div>
      <p className="max-w-md text-xs leading-relaxed text-white/75">
        {t("The SSH connection was lost and this terminal is no longer interactive. Reconnect to open a new shell on the same server (terminal history above stays visible).")}
      </p>
      {reason ? (
        <p className="max-w-md truncate font-mono text-[10px] text-white/45" title={reason}>
          {reason}
        </p>
      ) : null}
      {error ? <p className="max-w-md text-xs text-red-300">{error}</p> : null}
      {onReconnect ? (
        <button
          type="button"
          onClick={handleReconnect}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t("Reconnecting…")}
            </>
          ) : (
            <>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Reconnect")}
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

export default function XtermConsole({
  activeSessionId,
  activeSessionName,
  disconnected = false,
  disconnectReason = "",
  onReconnect,
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
  const activeSessionIdRef = useRef(activeSessionId);
  const activeSessionNameRef = useRef(activeSessionName);
  const disconnectedRef = useRef(disconnected);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onAttachSelectionRef = useRef(onAttachSelection);
  const unlistenRef = useRef(null);
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
    disconnectedRef.current = disconnected;
  }, [disconnected]);

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

  // Initialize xterm.js terminal (once)
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

    // Canvas renderer for GPU-accelerated rendering (major perf win over DOM renderer)
    import("@xterm/addon-canvas").then(({ CanvasAddon }) => {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        // Canvas renderer is optional; DOM fallback is fine if addon fails.
      }
    }).catch(() => {
      // Addon not available, DOM renderer will be used
    });

    term.attachCustomKeyEventHandler((event) => {
      const isSaveShortcut =
        event.type === "keydown" &&
        (event.key === "s" || event.key === "S") &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey;

      if (!isSaveShortcut) {
        return true;
      }

      event.preventDefault();
      event.stopPropagation();
      return false;
    });
    term.open(hostRef.current);
    term.focus();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Direct input: send keystrokes immediately, no batching delay
    const dataDisposable = term.onData((data) => {
      // Swallow keystrokes while the session is disconnected; the PTY worker
      // is gone and blind writes would only surface as errors.
      if (disconnectedRef.current) {
        return;
      }
      const sessionId = activeSessionIdRef.current;
      if (sessionId) {
        onInputRef.current?.(sessionId, data);
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const sessionId = activeSessionIdRef.current;
      if (sessionId && cols > 0 && rows > 0) {
        recordTerminalResize(sessionId, cols, rows, "xterm");
        onResizeRef.current?.(sessionId, cols, rows);
      }
    });

    const selectionDisposable = term.onSelectionChange(() => {
      setSelectionText(normalizeShellContextContent(term.getSelection()) || "");
    });

    const fitTerminal = () => {
      try {
        fitAddon.fit();
        const sessionId = activeSessionIdRef.current;
        if (sessionId && term.cols > 0 && term.rows > 0) {
          recordTerminalResize(sessionId, term.cols, term.rows, "fit");
          onResizeRef.current?.(sessionId, term.cols, term.rows);
        }
      } catch (_err) {
        // Ignore transient layout errors during mount / resize races.
      }
    };

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
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      term.dispose();
      fitAddonRef.current = null;
      termRef.current = null;
    };
  }, []);

  // Subscribe to PTY output events directly, bypassing React state entirely.
  // Only re-subscribes when the active session changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return undefined;
    }

    // Clean up previous listener
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    if (!activeSessionId) {
      term.reset();
      term.writeln(`\x1b[38;5;245m${t("No active sessions")}\x1b[0m`);
      return undefined;
    }

    term.reset();
    term.focus();

    // Notify backend of current terminal size for the new session
    if (term.cols > 0 && term.rows > 0) {
      recordTerminalResize(activeSessionId, term.cols, term.rows, "session-change");
      onResizeRef.current?.(activeSessionId, term.cols, term.rows);
    }

    let disposed = false;
    const sessionId = activeSessionId;

    listen("pty-output", (event) => {
      if (disposed) return;
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      if (payload.sessionId !== sessionId) return;
      const chunk = payload.chunk;
      if (typeof chunk !== "string" || !chunk) return;
      recordPtyChunk(sessionId, chunk.length);
      recordXtermWrite(sessionId, chunk.length, chunk.length);
      term.write(chunk);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenRef.current = unlisten;
      }
    }).catch(() => {
      // Failed to bind listener; terminal will be silent
    });

    return () => {
      disposed = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [activeSessionId, t]);

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
        {disconnected && activeSessionId ? (
          <XtermDisconnectOverlay reason={disconnectReason} onReconnect={onReconnect} />
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
