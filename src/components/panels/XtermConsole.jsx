import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { Loader2, Plus, RotateCcw, SquareTerminal, WifiOff } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  getTerminalWallpaperStyle,
  isDecoratedWallpaper,
  normalizeWallpaperSelection,
} from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";
import { normalizeShellContextContent } from "../../lib/ops-agent-shell-context";
import { recordTerminalResize, recordXtermWrite, recordPtyChunk } from "../../lib/terminal-perf-debug";
import { copyTextToClipboard, readTextFromClipboard } from "../../utils/clipboard";
import Button from "../ui/Button";
import XtermSelectionAction from "./xterm/XtermSelectionAction";

const transparentTerminalBackground = "rgba(0, 0, 0, 0)";

const TERMINAL_FONT = "JetBrains Mono Variable";

const XTERM_OPTIONS = {
  cursorBlink: true,
  convertEol: false,
  scrollback: 8_000,
  fontSize: 13,
  lineHeight: 1.3,
  fontFamily: `"${TERMINAL_FONT}", "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace`,
  allowTransparency: true,
  // Tuned for the navy terminal background; the cursor is the brand green.
  theme: {
    foreground: "#d5dae5",
    background: transparentTerminalBackground,
    cursor: "#3dd68c",
    cursorAccent: "#11141c",
    selectionBackground: "rgba(110, 168, 255, 0.3)",
    black: "#1c2130",
    red: "#ff6b7a",
    green: "#3dd68c",
    yellow: "#f0c05a",
    blue: "#6ea8ff",
    magenta: "#c792ea",
    cyan: "#56d4dd",
    white: "#c7cdd9",
    brightBlack: "#5c6479",
    brightRed: "#ff8b96",
    brightGreen: "#6be3a8",
    brightYellow: "#ffd580",
    brightBlue: "#92bfff",
    brightMagenta: "#dcb2ff",
    brightCyan: "#82e6ec",
    brightWhite: "#f2f4f8",
  },
};

// Start loading the bundled terminal face as soon as the module loads:
// xterm measures glyphs when a terminal opens, and a terminal opened on the
// fallback face would keep the wrong cell size.
const terminalFontReady =
  typeof document !== "undefined" && document.fonts?.load
    ? document.fonts.load(`${XTERM_OPTIONS.fontSize}px "${TERMINAL_FONT}"`).catch(() => [])
    : Promise.resolve([]);

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
    // On success the session's disconnected flag clears and this overlay unmounts.
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0b0d13]/70 px-6 backdrop-blur-[2px]">
      <div className="flex w-full max-w-md flex-col items-center gap-2.5 rounded-xl border border-white/10 bg-[#171b26]/95 px-6 py-5 text-center shadow-[0_18px_48px_rgba(0,0,0,0.45)]">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#ff6b7a]/14 text-[#ff8b96]">
          <WifiOff className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="text-sm font-semibold text-[#e3e7f0]">{t("Session disconnected")}</div>
        <p className="text-xs leading-relaxed text-[#8a93a9]">
          {t("The SSH connection was lost and this terminal is no longer interactive. Reconnect to open a new shell on the same server (terminal history above stays visible).")}
        </p>
        {reason ? (
          <p className="max-w-full truncate font-mono text-[10.5px] text-[#6b7389]" title={reason}>
            {reason}
          </p>
        ) : null}
        {error ? <p className="text-xs text-[#ff8b96]">{error}</p> : null}
        {onReconnect ? (
          <button
            type="button"
            onClick={handleReconnect}
            disabled={busy}
            className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-[#3dd68c] px-4 text-[13px] font-medium text-[#062015] transition-colors hover:bg-[#3dd68c]/88 disabled:opacity-60"
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
    </div>
  );
}

/**
 * Renders one xterm instance per shell session.
 *
 * Every session keeps its own terminal and scrollback for as long as the tab is
 * open, and all of them stay subscribed to PTY output. A single shared terminal
 * that was reset on every tab switch lost the history of both tabs and dropped
 * whatever a background session printed while it was not on screen.
 *
 * All hosts are stacked and laid out at full size; only the active one is
 * visible. Keeping inactive hosts in the layout (rather than `display: none`)
 * is what lets their terminals stay correctly sized, so output that arrives in
 * the background wraps at the same width the backend PTY is using.
 */
export default function XtermConsole({
  sessionIds,
  activeSessionId,
  activeSessionName,
  disconnected = false,
  disconnectReason = "",
  onReconnect,
  onInput,
  onResize,
  onAttachSelection,
  wallpaper,
  onNewSession,
}) {
  const { t } = useI18n();
  const containerRef = useRef(null);
  const terminalsRef = useRef(new Map());
  const activeSessionIdRef = useRef(activeSessionId);
  const activeSessionNameRef = useRef(activeSessionName);
  const disconnectedRef = useRef(disconnected);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onAttachSelectionRef = useRef(onAttachSelection);
  const [selectionText, setSelectionText] = useState("");
  const normalizedWallpaper = useMemo(() => normalizeWallpaperSelection(wallpaper), [wallpaper]);
  const wallpaperStyle = useMemo(() => getTerminalWallpaperStyle(normalizedWallpaper), [normalizedWallpaper]);

  // `sessionIds` is a fresh array on every parent render; depend on its contents
  // so terminals are not torn down and rebuilt on unrelated re-renders.
  const sessionIdKey = Array.isArray(sessionIds) ? sessionIds.join("|") : "";

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

  const fitTerminal = useCallback((entry, reason) => {
    if (!entry) {
      return;
    }
    try {
      entry.fitAddon.fit();
      if (entry.term.cols > 0 && entry.term.rows > 0) {
        recordTerminalResize(entry.sessionId, entry.term.cols, entry.term.rows, reason);
        onResizeRef.current?.(entry.sessionId, entry.term.cols, entry.term.rows);
      }
    } catch (_err) {
      // Ignore transient layout errors during mount / resize races.
    }
  }, []);

  // Creates the terminal for one session on demand and keeps it until the tab closes.
  const ensureTerminal = useCallback(
    (sessionId) => {
      if (!sessionId) {
        return null;
      }
      const existing = terminalsRef.current.get(sessionId);
      if (existing) {
        return existing;
      }
      const container = containerRef.current;
      if (!container) {
        return null;
      }

      const host = document.createElement("div");
      host.className = "terminal-session-host";
      // Set inline rather than with utility classes: this node is created
      // outside JSX, so it must not depend on the CSS scanner picking it up.
      host.style.position = "absolute";
      host.style.inset = "0";
      host.style.visibility = "hidden";
      container.appendChild(host);

      const term = new Xterm(XTERM_OPTIONS);
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Canvas renderer for GPU-accelerated rendering (major perf win over DOM renderer)
      import("@xterm/addon-canvas")
        .then(({ CanvasAddon }) => {
          try {
            term.loadAddon(new CanvasAddon());
          } catch {
            // Canvas renderer is optional; DOM fallback is fine if addon fails.
          }
        })
        .catch(() => {
          // Addon not available, DOM renderer will be used
        });

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") {
          return true;
        }

        const isSaveShortcut =
          (event.key === "s" || event.key === "S") &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey;
        if (isSaveShortcut) {
          event.preventDefault();
          event.stopPropagation();
          return false;
        }

        // Ctrl+Shift+C/V are the terminal's own clipboard shortcuts. xterm binds
        // neither: it only listens for the DOM `copy`/`paste` events, which a
        // WebView does not raise for its hidden textarea, so without this the
        // keys reach the shell as ^C / ^V instead of the clipboard.
        const isClipboardShortcut =
          event.ctrlKey &&
          event.shiftKey &&
          !event.altKey &&
          (event.key === "c" || event.key === "C" || event.key === "v" || event.key === "V");
        if (!isClipboardShortcut) {
          return true;
        }

        if (event.key === "c" || event.key === "C") {
          const selection = term.getSelection();
          // With nothing selected, fall through so the shell still sees ^C.
          if (!selection) {
            return true;
          }
          event.preventDefault();
          event.stopPropagation();
          void copyTextToClipboard(selection);
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        void readTextFromClipboard().then((text) => {
          // The read is async, so the tab may have been closed while it was in
          // flight; pasting into a disposed terminal throws.
          if (!text || terminalsRef.current.get(sessionId)?.term !== term) {
            return;
          }
          // `term.paste` applies bracketed-paste framing, which a raw
          // `onData` write would skip.
          term.paste(text);
        });
        return false;
      });
      term.open(host);

      const entry = { sessionId, term, fitAddon, host, disposables: [] };

      entry.disposables.push(
        term.onData((data) => {
          // Swallow keystrokes while the session is disconnected; the PTY worker
          // is gone and blind writes would only surface as errors.
          if (disconnectedRef.current && activeSessionIdRef.current === sessionId) {
            return;
          }
          onInputRef.current?.(sessionId, data);
        }),
      );

      entry.disposables.push(
        term.onResize(({ cols, rows }) => {
          if (cols > 0 && rows > 0) {
            recordTerminalResize(sessionId, cols, rows, "xterm");
            onResizeRef.current?.(sessionId, cols, rows);
          }
        }),
      );

      entry.disposables.push(
        term.onSelectionChange(() => {
          if (activeSessionIdRef.current !== sessionId) {
            return;
          }
          setSelectionText(normalizeShellContextContent(term.getSelection()) || "");
        }),
      );

      terminalsRef.current.set(sessionId, entry);
      fitTerminal(entry, "session-open");
      return entry;
    },
    [fitTerminal],
  );

  const disposeTerminal = useCallback((sessionId) => {
    const entry = terminalsRef.current.get(sessionId);
    if (!entry) {
      return;
    }
    terminalsRef.current.delete(sessionId);
    entry.disposables.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch (_err) {
        // Already disposed; nothing to clean up.
      }
    });
    try {
      entry.term.dispose();
    } catch (_err) {
      // Already disposed.
    }
    entry.host.remove();
  }, []);

  // Create terminals for newly opened tabs and drop the ones whose tab is gone.
  useEffect(() => {
    const ids = sessionIdKey ? sessionIdKey.split("|").filter(Boolean) : [];
    const live = new Set(ids);

    ids.forEach((sessionId) => {
      ensureTerminal(sessionId);
    });

    [...terminalsRef.current.keys()].forEach((sessionId) => {
      if (!live.has(sessionId)) {
        disposeTerminal(sessionId);
      }
    });
  }, [disposeTerminal, ensureTerminal, sessionIdKey]);

  // Show only the active session's terminal; the rest keep buffering off screen.
  useEffect(() => {
    terminalsRef.current.forEach((entry, sessionId) => {
      const isActive = sessionId === activeSessionId;
      entry.host.style.visibility = isActive ? "visible" : "hidden";
      entry.host.style.zIndex = isActive ? "1" : "0";
    });

    if (!activeSessionId) {
      return;
    }
    const entry = ensureTerminal(activeSessionId);
    if (!entry) {
      return;
    }
    fitTerminal(entry, "session-change");
    entry.term.focus();
  }, [activeSessionId, ensureTerminal, fitTerminal, sessionIdKey]);

  // One subscription for every session: a tab that is not on screen must keep
  // filling its own scrollback instead of losing what the server printed.
  useEffect(() => {
    let disposed = false;
    let unlisten = null;

    listen("pty-output", (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (!payload || typeof payload !== "object") {
        return;
      }
      const { sessionId, chunk } = payload;
      if (!sessionId || typeof chunk !== "string" || !chunk) {
        return;
      }
      const entry = terminalsRef.current.get(sessionId);
      if (!entry) {
        return;
      }
      recordPtyChunk(sessionId, chunk.length);
      recordXtermWrite(sessionId, chunk.length, chunk.length);
      entry.term.write(chunk);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch(() => {
        // Failed to bind listener; terminals will be silent.
      });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, []);

  // A terminal opened before the bundled face finished loading measured the
  // fallback font. Once it is ready, flip the family away and back — xterm
  // ignores a same-value option — so each terminal re-measures, then refit.
  useEffect(() => {
    let cancelled = false;
    void terminalFontReady.then(() => {
      if (cancelled) {
        return;
      }
      terminalsRef.current.forEach((entry) => {
        try {
          entry.term.options.fontFamily = "monospace";
          entry.term.options.fontFamily = XTERM_OPTIONS.fontFamily;
        } catch {
          // Disposed mid-flight; nothing to re-measure.
        }
        fitTerminal(entry, "font-ready");
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fitTerminal]);

  // Keep every terminal sized to the container, not just the visible one, so a
  // background tab does not reflow its scrollback the moment it is selected.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const fitAll = () => {
      terminalsRef.current.forEach((entry) => {
        fitTerminal(entry, "fit");
      });
    };

    const observer = new ResizeObserver(fitAll);
    observer.observe(container);
    window.addEventListener("resize", fitAll);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fitAll);
    };
  }, [fitTerminal]);

  useEffect(() => {
    const terminals = terminalsRef.current;
    return () => {
      terminals.forEach((entry) => {
        entry.disposables.forEach((disposable) => {
          try {
            disposable.dispose();
          } catch (_err) {
            // Already disposed.
          }
        });
        try {
          entry.term.dispose();
        } catch (_err) {
          // Already disposed.
        }
        entry.host.remove();
      });
      terminals.clear();
    };
  }, []);

  const handleAttachSelection = () => {
    const sessionId = activeSessionIdRef.current;
    const entry = sessionId ? terminalsRef.current.get(sessionId) : null;
    if (!entry || !selectionText) {
      return;
    }

    onAttachSelectionRef.current?.({
      sessionId,
      sessionName: activeSessionNameRef.current || "Shell",
      content: selectionText,
    });
    entry.term.clearSelection();
    setSelectionText("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="terminal-frame relative h-full w-full overflow-hidden">
        {selectionText ? (
          <XtermSelectionAction
            selectionLength={Array.from(selectionText).length}
            onClick={handleAttachSelection}
          />
        ) : null}
        {disconnected && activeSessionId ? (
          <XtermDisconnectOverlay reason={disconnectReason} onReconnect={onReconnect} />
        ) : null}
        {!activeSessionId ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center">
            <SquareTerminal className="h-8 w-8 text-[#5c6479]" strokeWidth={1.5} aria-hidden="true" />
            <div className="text-[13px] text-[#8a93a9]">{t("No active sessions")}</div>
            {onNewSession ? (
              <Button variant="primary" size="sm" onClick={onNewSession}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("New connection")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className={[
            "terminal-host relative h-full w-full",
            isDecoratedWallpaper(normalizedWallpaper) ? "terminal-host--tinted" : "",
            normalizedWallpaper.glass ? "terminal-host--glass" : "",
          ].join(" ")}
          style={wallpaperStyle}
        />
      </div>
    </div>
  );
}
