import { useCallback, useEffect, useRef } from "react";
import { EMPTY_SCRIPT, EMPTY_SSH } from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";
import { createPtyInputSender } from "../../lib/pty-input-sender";
import { api } from "../../lib/tauri-api";
import { normalizeRemotePath } from "../../utils/path";
import {
  isPtyLostError,
  isSessionGoneError,
  toErrorMessage,
} from "./errors";
import { shellQuote } from "./session";

const isConnectionCancelledError = (err) =>
  toErrorMessage(err).toLowerCase().includes("ssh connection cancelled");

const SSH_HOST_KEY_TRUST_REQUIRED_PREFIX = "SSH_HOST_KEY_TRUST_REQUIRED:";

const parseHostKeyTrustChallenge = (err) => {
  const message = toErrorMessage(err);
  const index = message.indexOf(SSH_HOST_KEY_TRUST_REQUIRED_PREFIX);
  if (index === -1) {
    return null;
  }
  const raw = message.slice(index + SSH_HOST_KEY_TRUST_REQUIRED_PREFIX.length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const SCRIPT_PARAMETER_PATTERN = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

const buildScriptCommand = (baseCommand, parameters, parameterValues) => {
  const command = String(baseCommand || "").trim();
  if (!command) {
    return "";
  }

  const normalizedParameters = Array.isArray(parameters)
    ? parameters
        .map((parameter) => ({
          name: String(parameter?.name || "").trim(),
          quote: parameter?.quote !== false,
          defaultValue: parameter?.defaultValue ?? "",
        }))
        .filter((parameter) => parameter.name)
    : [];
  if (normalizedParameters.length === 0) {
    return command;
  }

  const valueByName = new Map(
    normalizedParameters.map((parameter) => [
      parameter.name,
      parameterValues?.[parameter.name] ?? parameter.defaultValue ?? "",
    ]),
  );
  const formatValue = (parameter, value) =>
    parameter.quote === false ? String(value ?? "") : shellQuote(value ?? "");

  const usedNames = new Set();
  const replacedCommand = command.replace(
    SCRIPT_PARAMETER_PATTERN,
    (match, rawName) => {
      const parameter = normalizedParameters.find((item) => item.name === rawName);
      if (!parameter) {
        return match;
      }
      usedNames.add(parameter.name);
      return formatValue(parameter, valueByName.get(parameter.name));
    },
  );

  const appendedArgs = normalizedParameters
    .filter((parameter) => !usedNames.has(parameter.name))
    .flatMap((parameter) => {
      const rawValue = String(valueByName.get(parameter.name) ?? "");
      return rawValue ? [formatValue(parameter, rawValue)] : [];
    });

  return [replacedCommand, ...appendedArgs].join(" ").trim();
};

export function useWorkbenchOperations({
  sshConfigs,
  sessions,
  activeSessionId,
  downloadDirectory,
  scriptForm,
  scripts,
  sshForm,
  setLogs,
  setDisconnectedSessions,
  setSftpPath,
  setStatusBySession,
  setNicBySession,
  setSessions,
  setActiveSessionId,
  setOpenFileContent,
  setDirtyFile,
  setScripts,
  setScriptForm,
  setSshConfigs,
  setSshForm,
  setDownloadDirectory,
  setError,
  reconnectingSessionsRef,
  closingSessionsRef,
  statusRequestTokenRef,
  ptyInputSenderRef,
  onErrorRef,
  runWithSessionReconnectRef,
  pushUiNotice,
  dismissUiNotice,
  requestHostKeyTrust,
  runBusy,
  onError,
}) {
  const { localeTag, t } = useI18n();
  const localeTagRef = useRef(localeTag);
  const tRef = useRef(t);

  useEffect(() => {
    localeTagRef.current = localeTag;
    tRef.current = t;
  }, [localeTag, t]);

  const appendLog = useCallback((sessionId, tag, text) => {
    if (!sessionId || !text) {
      return;
    }
    setLogs((prev) => {
      const rows = prev[sessionId] || [];
      return {
        ...prev,
        [sessionId]: [
          ...rows,
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            ts: new Date().toLocaleTimeString(localeTagRef.current),
            tag,
            text,
          },
        ],
      };
    });
  }, []);

  // A session id is now stable for the lifetime of its tab: recovering a dead
  // PTY reopens the channel under the same id instead of replacing the session,
  // so there is no old-to-new id mapping to resolve any more.
  const resolveSessionAlias = useCallback((sessionId) => sessionId || null, []);

  const isSessionClosing = useCallback(
    (sessionId) => Boolean(sessionId) && closingSessionsRef.current.has(sessionId),
    [closingSessionsRef],
  );

  const clearSessionArtifacts = useCallback((sessionId) => {
    if (!sessionId) {
      return;
    }

    const relatedSessionIds = new Set([sessionId]);

    const inputSender = ptyInputSenderRef.current;
    if (inputSender) {
      relatedSessionIds.forEach((id) => {
        inputSender.clearSession(id);
      });
    }

    reconnectingSessionsRef.current.delete(sessionId);
    statusRequestTokenRef.current.delete(sessionId);

    setDisconnectedSessions((prev) => {
      const keys = [...relatedSessionIds].filter((id) => id in prev);
      if (keys.length === 0) {
        return prev;
      }
      const next = { ...prev };
      keys.forEach((id) => {
        delete next[id];
      });
      return next;
    });

    setSftpPath((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setStatusBySession((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setNicBySession((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setLogs((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const clearDisconnectedFlags = useCallback(
    (...sessionIds) => {
      setDisconnectedSessions((prev) => {
        const keys = sessionIds.filter((id) => id && id in prev);
        if (keys.length === 0) {
          return prev;
        }
        const next = { ...prev };
        keys.forEach((id) => {
          delete next[id];
        });
        return next;
      });
    },
    [setDisconnectedSessions],
  );

  // Marks one session as non-interactive after its PTY died; the terminal
  // shows a reconnect overlay until `reopenSessionPty` revives the same tab.
  const markSessionDisconnected = useCallback(
    (sessionId, reason = "") => {
      if (!sessionId || isSessionClosing(sessionId)) {
        return;
      }
      let alreadyMarked = false;
      setDisconnectedSessions((prev) => {
        if (sessionId in prev) {
          alreadyMarked = true;
          return prev;
        }
        return { ...prev, [sessionId]: String(reason || "connection_lost") };
      });
      if (!alreadyMarked) {
        appendLog(
          sessionId,
          "SYSTEM",
          tRef.current("Connection lost. The terminal is no longer interactive."),
        );
      }
    },
    [appendLog, isSessionClosing, setDisconnectedSessions],
  );

  // Rebuilds a tab's PTY channel in place. The session id is preserved, so the
  // tab, its working directory, its SFTP path and its status cache all survive;
  // nothing is opened and nothing is orphaned.
  const reopenSessionPty = useCallback(
    async (sessionId) => {
      const targetSessionId = resolveSessionAlias(sessionId);
      if (!targetSessionId) {
        throw new Error(tRef.current("No shell session selected"));
      }
      if (isSessionClosing(targetSessionId)) {
        throw new Error(tRef.current("Shell session is closing"));
      }

      const existing = reconnectingSessionsRef.current.get(targetSessionId);
      if (existing) {
        return existing;
      }

      const task = (async () => {
        const session = await api.reopenShellPty(targetSessionId);
        if (isSessionClosing(targetSessionId)) {
          throw new Error(tRef.current("Shell session is closing"));
        }

        // The PTY is a fresh shell, so the tracked directory has to be restored
        // by hand. The session record itself is untouched.
        const restoreDir = normalizeRemotePath(session.currentDir || "/");
        if (restoreDir && restoreDir !== "/") {
          try {
            await api.ptyWriteInput(targetSessionId, `cd ${shellQuote(restoreDir)}\n`);
          } catch (_err) {
            // A failed cd leaves the tab usable at the login directory.
          }
        }

        setSessions((prev) =>
          prev.map((item) => (item.id === targetSessionId ? { ...item, ...session } : item)),
        );
        clearDisconnectedFlags(targetSessionId);
        appendLog(targetSessionId, "SYSTEM", tRef.current("Session reconnected."));
        return session;
      })();

      reconnectingSessionsRef.current.set(targetSessionId, task);
      try {
        return await task;
      } finally {
        reconnectingSessionsRef.current.delete(targetSessionId);
      }
    },
    [appendLog, clearDisconnectedFlags, isSessionClosing, resolveSessionAlias],
  );

  // Runs one operation against a tab, rebuilding its PTY once if the worker died.
  //
  // Only a dead PTY is recovered. A removed tab (`isSessionGoneError`) is
  // surfaced instead: reopening against it cannot succeed, and retrying it is
  // what used to spawn a fresh session on every poll.
  const runWithSessionReconnect = useCallback(
    async (sessionId, action) => {
      const resolvedSessionId = resolveSessionAlias(sessionId);
      if (!resolvedSessionId) {
        throw new Error(tRef.current("No shell session selected"));
      }
      if (isSessionClosing(resolvedSessionId)) {
        throw new Error(tRef.current("Shell session is closing"));
      }

      try {
        return await action(resolvedSessionId);
      } catch (err) {
        if (!isPtyLostError(err)) {
          throw err;
        }
        if (isSessionClosing(resolvedSessionId)) {
          throw err;
        }
        await reopenSessionPty(resolvedSessionId);
        return action(resolvedSessionId);
      }
    },
    [isSessionClosing, reopenSessionPty, resolveSessionAlias],
  );

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    runWithSessionReconnectRef.current = runWithSessionReconnect;
  }, [runWithSessionReconnect]);

  // Assigned synchronously too (not only in the effect above): plugin
  // controllers mount before this hook's effects flush, and their first poll
  // needs the current implementation immediately.
  runWithSessionReconnectRef.current = runWithSessionReconnect;
  onErrorRef.current = onError;

  useEffect(() => {
    const sender = createPtyInputSender({
      send: (sessionId, data) => {
        const runWithReconnect = runWithSessionReconnectRef.current;
        if (typeof runWithReconnect !== "function") {
          return Promise.reject(new Error(tRef.current("PTY input sender is not ready")));
        }
        return runWithReconnect(sessionId, (activeId) => api.ptyWriteInput(activeId, data));
      },
      onError: (error) => {
        onErrorRef.current(error);
      },
    });
    ptyInputSenderRef.current = sender;

    return () => {
      sender.dispose();
      if (ptyInputSenderRef.current === sender) {
        ptyInputSenderRef.current = null;
      }
    };
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      await runBusy(tRef.current("Loading project"), async () => {
        const loadDefaultDirTask = downloadDirectory?.trim()
          ? Promise.resolve(downloadDirectory)
          : api.sftpDefaultDownloadDir().catch(() => "");

        const [
          configs,
          scriptRows,
          opened,
          defaultDownloadDir,
        ] = await Promise.all([
          api.listSshConfigs(),
          api.listScripts(),
          api.listShellSessions(),
          loadDefaultDirTask,
        ]);
        setSshConfigs(configs);
        setScripts(scriptRows);
        if (!downloadDirectory?.trim() && defaultDownloadDir) {
          setDownloadDirectory(defaultDownloadDir);
        }

        setSessions(opened);
        if (opened[0]) {
          setActiveSessionId(opened[0].id);
        }
      });
    } catch (err) {
      onError(err);
    }
  }, [downloadDirectory, onError, runBusy, setDownloadDirectory]);

  const reloadSessions = useCallback(async () => {
    const rows = await api.listShellSessions();
    setSessions(rows);
    return rows;
  }, []);

  const saveSsh = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy(tRef.current("Save SSH config"), () =>
          api.saveSshConfig({
            id: sshForm.id || null,
            name: sshForm.name,
            host: sshForm.host,
            port: Number(sshForm.port || 22),
            username: sshForm.username,
            authType: sshForm.authType || "password",
            password: sshForm.password,
            privateKeyPath: sshForm.privateKeyPath || "",
            privateKeyPassphrase: sshForm.privateKeyPassphrase || "",
            usePasswordFallback: Boolean(sshForm.usePasswordFallback),
            description: sshForm.description,
          }),
        );
        setSshForm(EMPTY_SSH);
        setSshConfigs(await api.listSshConfigs());
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [onError, runBusy, sshForm],
  );

  const connectServer = useCallback(
    async (configId, requestId = null) => {
      const targetConfig = sshConfigs.find((item) => item.id === configId) || null;
      const targetLabel =
        targetConfig?.name || targetConfig?.host || tRef.current("SSH Servers");
      const connectionRequestId =
        requestId ||
        globalThis.crypto?.randomUUID?.() ||
        `connect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const pendingNoticeId = pushUiNotice(
        tRef.current("Connecting to {target}...", { target: targetLabel }),
        {
        tone: "info",
        ttlMs: 0,
        },
      );

      try {
        const session = await runBusy(tRef.current("Open SSH session"), () =>
          api.openShellSession(configId, connectionRequestId),
        );
        dismissUiNotice(pendingNoticeId);
        await reloadSessions();
        setActiveSessionId(session.id);
        setSftpPath((prev) => ({
          ...prev,
          [session.id]: normalizeRemotePath(session.currentDir || "/"),
        }));
        const hasDirectory =
          typeof session.currentDir === "string" && session.currentDir.trim().length > 0;
        const connectedMessage = tRef.current(
          hasDirectory ? "Connected to {name} ({dir})" : "Connected to {name}",
          { name: session.configName, dir: session.currentDir },
        );
        appendLog(session.id, "SYSTEM", connectedMessage);
        pushUiNotice(connectedMessage, {
          tone: "success",
          ttlMs: 4200,
        });
        return true;
      } catch (err) {
        dismissUiNotice(pendingNoticeId);
        if (isConnectionCancelledError(err)) {
          pushUiNotice(tRef.current("SSH connection cancelled"), {
            tone: "info",
            ttlMs: 3200,
          });
          return false;
        }
        const hostKeyChallenge = parseHostKeyTrustChallenge(err);
        if (hostKeyChallenge) {
          const isChanged = hostKeyChallenge.reason === "changed";
          const title = isChanged
            ? tRef.current("SSH host fingerprint changed")
            : tRef.current("Trust new SSH host?");
          const body = isChanged
            ? tRef.current(
                "The SSH host fingerprint for {host}:{port} changed.\n\nTrusted fingerprint: {trustedFingerprint}\nPresented fingerprint: {fingerprint}\nKey type: {keyType}\n\nOnly continue if you expected this server key to change.",
                {
                  host: hostKeyChallenge.host,
                  port: hostKeyChallenge.port,
                  trustedFingerprint: hostKeyChallenge.trustedFingerprint || tRef.current("Unknown"),
                  fingerprint: hostKeyChallenge.fingerprint,
                  keyType: hostKeyChallenge.keyType,
                },
              )
            : tRef.current(
                "This is the first time eShell has seen {host}:{port}.\n\nKey type: {keyType}\nFingerprint: {fingerprint}\n\nTrust this host and continue connecting?",
                {
                  host: hostKeyChallenge.host,
                  port: hostKeyChallenge.port,
                  keyType: hostKeyChallenge.keyType,
                  fingerprint: hostKeyChallenge.fingerprint,
                },
              );
          const accepted = await requestHostKeyTrust?.({
            ...hostKeyChallenge,
            isChanged,
            title,
            body,
          });
          if (!accepted) {
            pushUiNotice(tRef.current("SSH host fingerprint was not trusted"), {
              tone: "warning",
              ttlMs: 4200,
            });
            return false;
          }
          await api.trustSshHostKey({
            host: hostKeyChallenge.host,
            port: Number(hostKeyChallenge.port || 22),
            keyType: hostKeyChallenge.keyType,
            fingerprint: hostKeyChallenge.fingerprint,
          });
          pushUiNotice(tRef.current("SSH host fingerprint trusted"), {
            tone: "success",
            ttlMs: 3200,
          });
          return connectServer(configId, null);
        }
        const reason = toErrorMessage(err);
        const message = tRef.current("Failed to connect to {target}: {reason}", {
          target: targetLabel,
          reason,
        });
        setError(message);
        pushUiNotice(message, { tone: "danger" });
        return false;
      }
    },
    [
      appendLog,
      dismissUiNotice,
      pushUiNotice,
      reloadSessions,
      requestHostKeyTrust,
      runBusy,
      setError,
      sshConfigs,
    ],
  );

  const closeSession = useCallback(
    async (sessionId) => {
      if (!sessionId) {
        return;
      }
      const resolvedSessionId = resolveSessionAlias(sessionId);
      const relatedSessionIds = new Set([sessionId, resolvedSessionId]);
      relatedSessionIds.forEach((id) => {
        if (id) {
          closingSessionsRef.current.add(id);
        }
      });
      const remainingSessions = sessions.filter(
        (item) => item.id !== sessionId && item.id !== resolvedSessionId,
      );
      setSessions(remainingSessions);
      if (activeSessionId === sessionId || activeSessionId === resolvedSessionId) {
        setActiveSessionId(remainingSessions[0]?.id || null);
      }
      clearSessionArtifacts(resolvedSessionId);
      if (resolvedSessionId !== sessionId) {
        clearSessionArtifacts(sessionId);
      }

      try {
        await runBusy(tRef.current("Close session"), () => api.closeShellSession(resolvedSessionId));
        const rows = await reloadSessions();
        const filteredRows = rows.filter(
          (item) => item.id !== sessionId && item.id !== resolvedSessionId,
        );
        if (filteredRows.length !== rows.length) {
          setSessions(filteredRows);
        }
        if (
          (activeSessionId === sessionId || activeSessionId === resolvedSessionId) &&
          filteredRows[0]
        ) {
          setActiveSessionId(filteredRows[0].id);
        }
      } catch (err) {
        // Closing a tab that is already gone is the expected outcome, not a
        // failure worth surfacing.
        if (!isSessionGoneError(err)) {
          onError(err);
        }
      } finally {
        relatedSessionIds.forEach((id) => {
          if (id) {
            closingSessionsRef.current.delete(id);
          }
        });
        if (activeSessionId === sessionId || activeSessionId === resolvedSessionId) {
          const fallbackSessionId = remainingSessions[0]?.id || null;
          setSessions((prev) =>
            prev.filter((item) => item.id !== sessionId && item.id !== resolvedSessionId),
          );
          setActiveSessionId((prev) =>
            prev === sessionId || prev === resolvedSessionId ? fallbackSessionId : prev,
          );
        }
      }
    },
    [
      activeSessionId,
      clearSessionArtifacts,
      closingSessionsRef,
      onError,
      reloadSessions,
      resolveSessionAlias,
      runBusy,
      sessions,
    ],
  );

  const sendCommandDraft = useCallback(
    async (text) => {
      const command = String(text || "").replace(/\r\n/g, "\n").trim();
      if (!activeSessionId || !command) {
        return;
      }
      try {
        await runWithSessionReconnect(activeSessionId, (sessionId) =>
          api.ptyWriteInput(sessionId, `${command}\n`),
        );
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, onError, runWithSessionReconnect],
  );

  const cancelConnectServer = useCallback(
    async (requestId) => {
      if (!requestId) {
        return false;
      }
      try {
        await api.cancelOpenShellSession(requestId);
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [onError],
  );

  const saveScript = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy(tRef.current("Save script"), () =>
          api.saveScript({
            ...scriptForm,
            parameters: Array.isArray(scriptForm.parameters)
              ? scriptForm.parameters
              : [],
          }),
        );
        setScriptForm(EMPTY_SCRIPT);
        setScripts(await api.listScripts());
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy, scriptForm],
  );

  const runScript = useCallback(
    async (scriptId, parameterValues = {}) => {
      if (!activeSessionId) {
        onError(tRef.current("Please connect an SSH session first"));
        return false;
      }

      const script = scripts.find((item) => item.id === scriptId);
      if (!script) {
        onError(tRef.current("Script not found"));
        return false;
      }

      const directCommand = (script.command || "").trim();
      const scriptPath = (script.path || "").trim();
      const baseCommand = directCommand || (scriptPath ? `bash ${shellQuote(scriptPath)}` : "");
      const parameters = Array.isArray(script.parameters) ? script.parameters : [];
      const missingParameter = parameters.find((parameter) => {
        const name = String(parameter?.name || "").trim();
        if (!name || !parameter?.required) {
          return false;
        }
        return !String(parameterValues[name] ?? parameter.defaultValue ?? "").trim();
      });
      if (missingParameter) {
        onError(
          tRef.current("Missing required script parameter: {name}", {
            name: missingParameter.label || missingParameter.name,
          }),
        );
        return false;
      }
      const resolvedCommand = buildScriptCommand(baseCommand, parameters, parameterValues);
      if (!resolvedCommand) {
        onError(tRef.current("Script has no runnable command or path"));
        return false;
      }

      try {
        await runBusy(tRef.current("Run script"), () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.ptyWriteInput(sessionId, `${resolvedCommand}\n`),
          ),
        );
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [activeSessionId, onError, runBusy, runWithSessionReconnect, scripts],
  );

  const sendPtyInput = useCallback(
    (sessionId, data) => {
      if (!sessionId || !data) {
        return;
      }
      const sender = ptyInputSenderRef.current;
      if (sender) {
        sender.enqueue(sessionId, data);
        return;
      }

      const runWithReconnect = runWithSessionReconnectRef.current;
      if (!runWithReconnect) {
        return;
      }
      void runWithReconnect(sessionId, (activeId) => api.ptyWriteInput(activeId, data)).catch((error) => {
        onErrorRef.current(error);
      });
    },
    [],
  );

  const resizePty = useCallback((sessionId, cols, rows) => {
    if (!sessionId || !cols || !rows) {
      return;
    }
    void runWithSessionReconnect(sessionId, (activeId) => api.ptyResize(activeId, cols, rows)).catch(() => {
      // Ignore transient resize failures caused by tab switching.
    });
  }, [runWithSessionReconnect]);

  const handleDeleteSsh = useCallback(
    async (sshId) => {
      try {
        await runBusy(tRef.current("Delete SSH config"), () => api.deleteSshConfig(sshId));
        setSshConfigs(await api.listSshConfigs());
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy],
  );

  const handleDeleteScript = useCallback(
    async (scriptId) => {
      try {
        await runBusy(tRef.current("Delete script"), () => api.deleteScript(scriptId));
        setScripts(await api.listScripts());
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy],
  );

  const handleOpenFileContentChange = useCallback((value) => {
    setOpenFileContent(value);
    setDirtyFile(true);
  }, []);

  const handleDownloadDirectoryChange = useCallback(
    (value) => {
      if (typeof value !== "string") {
        return;
      }
      setDownloadDirectory(value.trim());
    },
    [setDownloadDirectory],
  );

  return {
    appendLog,
    resolveSessionAlias,
    runWithSessionReconnect,
    reopenSessionPty,
    markSessionDisconnected,
    bootstrap,
    saveSsh,
    connectServer,
    cancelConnectServer,
    closeSession,
    sendCommandDraft,
    saveScript,
    runScript,
    sendPtyInput,
    resizePty,
    handleDeleteSsh,
    handleDeleteScript,
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
  };
}
