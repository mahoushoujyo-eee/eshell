import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const XTERM_OPTIONS = {
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
};

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
        {!activeSessionId ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-muted">
            {t("No active sessions")}
          </div>
        ) : null}
        <div
          ref={containerRef}
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
