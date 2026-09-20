import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeRemotePath } from "../../utils/path";

/**
 * SFTP-owned workbench state, moved verbatim from `hooks/useWorkbench.js`.
 *
 * The defaults are byte-identical to the pre-plugin ones, including the
 * `eshell:sftp-download-dir` localStorage key and initializer order.
 * `downloadDirectory` is SFTP-owned (it is the local target of every
 * transfer); the workbench keeps exposing it through the compat adapter.
 */
export function useSftpState() {
  const [sftpPath, setSftpPath] = useState({});
  const [sftpEntries, setSftpEntries] = useState([]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [sftpTransfers, setSftpTransfers] = useState([]);
  const [downloadDirectory, setDownloadDirectory] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem("eshell:sftp-download-dir") || "";
  });

  const [openFilePath, setOpenFilePath] = useState("");
  // Which session the open file was read from. Saves must go back to that
  // session rather than whichever tab happens to be active when the debounced
  // write fires, otherwise switching tabs mid-edit writes to the wrong server.
  const [openFileSessionId, setOpenFileSessionId] = useState(null);
  const [openFileContent, setOpenFileContent] = useState("");
  const [dirtyFile, setDirtyFile] = useState(false);

  // Debounced-save timer, owned here since only the sftp plugin schedules it.
  const saveTimerRef = useRef(null);

  // Persistence for the local download directory, moved verbatim from the
  // core effects (same key, same write condition).
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:sftp-download-dir", downloadDirectory || "");
  }, [downloadDirectory]);

  const resetFileEditor = useCallback(() => {
    setOpenFilePath("");
    setOpenFileSessionId(null);
    setOpenFileContent("");
    setDirtyFile(false);
  }, []);

  return {
    sftpPath,
    setSftpPath,
    sftpEntries,
    setSftpEntries,
    selectedEntry,
    setSelectedEntry,
    sftpTransfers,
    setSftpTransfers,
    downloadDirectory,
    setDownloadDirectory,
    openFilePath,
    setOpenFilePath,
    openFileSessionId,
    setOpenFileSessionId,
    openFileContent,
    setOpenFileContent,
    dirtyFile,
    setDirtyFile,
    saveTimerRef,
    resetFileEditor,
  };
}

/**
 * `currentPath` derivation, moved verbatim: the active session's tracked SFTP
 * path, falling back to its login directory, normalized.
 */
export const deriveCurrentPath = ({ activeSession, sftpPath }) =>
  normalizeRemotePath(
    activeSession ? sftpPath[activeSession.id] || activeSession.currentDir || "/" : "/",
  );

export const useMemoCurrentPath = ({ activeSession, sftpPath }) =>
  useMemo(() => deriveCurrentPath({ activeSession, sftpPath }), [activeSession, sftpPath]);
