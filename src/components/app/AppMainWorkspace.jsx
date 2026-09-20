import { useCallback, useRef } from "react";
import KeepAlive from "../KeepAlive";
import SplitPane from "../SplitPane";
import CommandDraftPanel from "../panels/CommandDraftPanel";
import TerminalPanel from "../panels/TerminalPanel";
import {
  SFTP_EXTENSION_ID,
  STATUS_EXTENSION_ID,
  getPlugin,
  resolvePanelContributions,
} from "../../plugins";
import { useRegistryVersion } from "../../plugins/runtime/useRegistry";
import ExternalPanelHost from "../../plugins/runtime/ExternalPanelHost";

// Builtin panel keys get their original render props (the compat adapter):
// the workbench values mapped per builtin plugin, unchanged. External panels
// render through ExternalPanelHost with `{ api, context, controller }`.
const builtinPanelProps = (panel, workbench, onOpenFileEditor) => {
  const {
    activeSessionId,
    currentPath,
    currentStatus,
    currentNic,
    requestSftpDir,
    refreshSftp,
    uploadFile,
    createSftpEntry,
    downloadFile,
    deleteSftpEntry,
    renameSftpEntry,
    copySftpEntryPath,
    cancelSftpTransfer,
    downloadDirectory,
    handleDownloadDirectoryChange,
    sftpTransfers,
    selectedEntry,
    sftpEntries,
    openEntry,
    selectSftpEntry,
    handleNicChange,
    statusRefreshInterval,
    setStatusRefreshInterval,
    formatBytes,
  } = workbench;

  if (panel.pluginId === SFTP_EXTENSION_ID) {
    return {
      activeSessionId,
      currentPath,
      requestSftpDir,
      refreshSftp,
      uploadFile,
      createSftpEntry,
      downloadFile,
      deleteSftpEntry,
      renameSftpEntry,
      copySftpEntryPath,
      cancelTransfer: cancelSftpTransfer,
      downloadDirectory,
      onDownloadDirectoryChange: handleDownloadDirectoryChange,
      transfers: sftpTransfers,
      selectedEntry,
      sftpEntries,
      openEntry,
      selectSftpEntry,
      onOpenFileEditor,
      formatBytes,
    };
  }
  if (panel.pluginId === STATUS_EXTENSION_ID) {
    return {
      activeSessionId,
      currentStatus,
      currentNic,
      onNicChange: handleNicChange,
      formatBytes,
      refreshInterval: statusRefreshInterval,
      onRefreshIntervalChange: setStatusRefreshInterval,
    };
  }
  return null;
};

export default function AppMainWorkspace({
  workbench,
  acp,
  showSftpPanel,
  showStatusPanel,
  showCommandDraftPanel,
  onOpenFileEditor,
}) {
  const {
    activeSessionId,
    setActiveSessionId,
    activeSession,
    commandDraft,
    setCommandDraft,
    sessions,
    wallpaper,
    closeSession,
    reopenSessionPty,
    disconnectedSessions,
    sendCommandDraft,
    sendPtyInput,
    resizePty,
    setShowAiPanel,
    extensions,
  } = workbench;

  // Re-resolve contributions when the registry changes (a late external
  // registration or a disable), not only when the workbench re-renders.
  useRegistryVersion();

  // Stable slot nodes — one per panel, created once and never re-created.
  // KeepAlive moves each panel's host node into its slot when visible; layout
  // below only arranges slot mount points, so panel trees never unmount.
  //
  // The slot map is instance-owned (a ref on this component), not a module
  // global: two workspaces never share DOM, and an unmount releases its own
  // nodes. Slots are created lazily per panel key, so a plugin installed
  // later gets its own slot without any pre-declared key list.
  const slotsRef = useRef(new Map());
  const getSlotRef = useCallback((key) => {
    let slotRef = slotsRef.current.get(key);
    if (!slotRef) {
      slotRef = { current: null };
      slotsRef.current.set(key, slotRef);
    }
    // The slot node is created lazily per key (same as the pre-plugin
    // per-panel useRef), so a panel registered later still gets a stable
    // slot node on its first render — before KeepAlive's layout effect
    // looks for it.
    if (slotRef.current === null && typeof document !== "undefined") {
      slotRef.current = document.createElement("div");
      slotRef.current.className = "h-full w-full";
    }
    return slotRef;
  }, []);

  const terminalPanel = (
    <TerminalPanel
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={setActiveSessionId}
      onCloseSession={closeSession}
      onReconnectSession={reopenSessionPty}
      disconnectedSessions={disconnectedSessions}
      activeSession={activeSession}
      onPtyInput={sendPtyInput}
      onPtyResize={resizePty}
      onAttachSelectionToAi={(selection) => {
        acp.attachShellContext(selection);
        setShowAiPanel(true);
      }}
      wallpaper={wallpaper}
    />
  );

  // Plugin-contributed bottom panels, resolved against the shared manifest in
  // discovery order (sftp, then status, then externals). Disabled extensions
  // contribute nothing: their entry is filtered out below, so the panel and
  // its toolbar button both disappear until re-enabled.
  //
  // Builtin panels keep the compat adapter (original props, original
  // showSftpPanel/showStatusPanel visibility props); external panels render
  // through ExternalPanelHost with `{ api, context, controller }` and read
  // the generic visibility map, error-isolated at the plugin boundary.
  const pluginPanels = resolvePanelContributions(extensions)
    .filter((panel) => panel.enabled)
    .map((panel) => {
      const plugin = getPlugin(panel.pluginId);
      if (!plugin) {
        // Registered implementation missing (unregistered mid-render):
        // skip this panel, never blank the dock.
        return null;
      }
      const slotRef = getSlotRef(panel.key);
      if (plugin.builtin === false) {
        return {
          key: panel.key,
          visible: workbench.panelVisibility?.[panel.key] === true,
          slotRef,
          node: <ExternalPanelHost panel={panel} plugin={plugin} />,
        };
      }
      const props = builtinPanelProps(panel, workbench, onOpenFileEditor);
      if (!props) {
        // An unknown builtin panel (manifest drift) renders nothing; it is
        // skipped, not thrown, so the rest of the dock still lays out.
        return null;
      }
      const visible =
        panel.key === "sftp"
          ? showSftpPanel === true
          : panel.key === "status"
            ? showStatusPanel === true
            : workbench.panelVisibility?.[panel.key] === true;
      return {
        key: panel.key,
        visible,
        slotRef,
        node: panel.render(props),
      };
    })
    .filter(Boolean);

  const bottomPanels = [
    ...pluginPanels,
    {
      key: "draft",
      visible: showCommandDraftPanel === true,
      slotRef: getSlotRef("draft"),
      node: (
        <CommandDraftPanel
          activeSessionId={activeSessionId}
          draft={commandDraft}
          onDraftChange={setCommandDraft}
          onSend={sendCommandDraft}
        />
      ),
    },
  ];

  const visibleBottomPanels = bottomPanels.filter((panel) => panel.visible);

  // Layout: arrange stable slot mount points. Each mount point is a plain
  // wrapper div rendered by React; the persistent slot node is moved into it
  // via callback ref. When React unmounts the wrapper (layout change), the
  // slot is detached with it — but the slot node itself survives in the ref
  // and is re-attached to the next wrapper, so panel content is never lost.
  //
  // 0/1/2/3 keep the original SplitPane structures, ratios and identities;
  // 4+ nests the remainder the same way, so additional panels lay out
  // normally instead of blanking the whole dock.
  const mountSlot = (slotRef) => (wrapper) => {
    if (wrapper && slotRef.current && slotRef.current.parentNode !== wrapper) {
      wrapper.appendChild(slotRef.current);
    }
  };

  const slotElement = (panel) => (
    <div key={panel.key} ref={mountSlot(panel.slotRef)} className="h-full w-full" />
  );

  const nestPanels = (panels) => {
    if (panels.length === 0) {
      return null;
    }
    if (panels.length === 1) {
      return slotElement(panels[0]);
    }
    if (panels.length === 2) {
      return (
        <SplitPane
          direction="horizontal"
          initialRatio={0.58}
          minPrimarySize={420}
          minSecondarySize={280}
          primary={slotElement(panels[0])}
          secondary={slotElement(panels[1])}
        />
      );
    }
    if (panels.length === 3) {
      return (
        <SplitPane
          direction="horizontal"
          initialRatio={0.58}
          minPrimarySize={420}
          minSecondarySize={280}
          primary={slotElement(panels[0])}
          secondary={
            <SplitPane
              direction="horizontal"
              initialRatio={0.58}
              minPrimarySize={280}
              minSecondarySize={220}
              primary={slotElement(panels[1])}
              secondary={slotElement(panels[2])}
            />
          }
        />
      );
    }
    // 4+: the first pane plus the nested remainder, same shape as the 3 case.
    return (
      <SplitPane
        direction="horizontal"
        initialRatio={0.58}
        minPrimarySize={420}
        minSecondarySize={280}
        primary={slotElement(panels[0])}
        secondary={nestPanels(panels.slice(1))}
      />
    );
  };

  const bottomPanelsContent = nestPanels(visibleBottomPanels);

  return (
    <>
      {/* Panel component trees live in portals here; they never unmount. */}
      {bottomPanels.map((panel) => (
        <KeepAlive key={panel.key} active={panel.visible} slotRef={panel.slotRef}>
          {panel.node}
        </KeepAlive>
      ))}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <SplitPane
          direction="vertical"
          initialRatio={0.5}
          minPrimarySize={290}
          minSecondarySize={280}
          collapseSecondary={!bottomPanelsContent}
          collapsedSecondarySize={0}
          primary={terminalPanel}
          secondary={<section className="h-full">{bottomPanelsContent}</section>}
        />
      </div>
    </>
  );
}
