import { useEffect, useRef, useState } from "react";
import AppModals from "./components/app/AppModals";
import AppWorkspace from "./components/app/AppWorkspace";
import { useWorkbench } from "./hooks/useWorkbench";

const DEFAULT_AI_PANEL_WIDTH = 460;
const MIN_AI_PANEL_WIDTH = 360;
const MAX_AI_PANEL_WIDTH = 760;
const MIN_MAIN_WORKSPACE_WIDTH = 420;

const clampAiPanelWidth = (width, containerWidth = 0) => {
  const numericWidth = Number(width);
  const safeWidth = Number.isFinite(numericWidth) ? numericWidth : DEFAULT_AI_PANEL_WIDTH;
  if (!containerWidth || containerWidth <= 0) {
    return Math.min(MAX_AI_PANEL_WIDTH, Math.max(MIN_AI_PANEL_WIDTH, safeWidth));
  }

  const maxByContainer = Math.max(320, containerWidth - MIN_MAIN_WORKSPACE_WIDTH);
  const maxWidth = Math.min(MAX_AI_PANEL_WIDTH, maxByContainer);
  const minWidth = Math.min(MIN_AI_PANEL_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, safeWidth));
};

function App() {
  const [isSshModalOpen, setIsSshModalOpen] = useState(false);
  const [isScriptModalOpen, setIsScriptModalOpen] = useState(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [isFileEditorOpen, setIsFileEditorOpen] = useState(false);
  const [isWallpaperModalOpen, setIsWallpaperModalOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("eshell:sidebar-collapsed") === "1";
  });
  const [aiPanelWidth, setAiPanelWidth] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_AI_PANEL_WIDTH;
    }

    const stored = Number(window.localStorage.getItem("eshell:ai-panel-width"));
    return clampAiPanelWidth(stored);
  });
  const [isAiPanelResizing, setIsAiPanelResizing] = useState(false);
  const workspaceRef = useRef(null);

  const workbench = useWorkbench();

  useEffect(() => {
    if (!workbench.showAiPanel) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        workbench.setShowAiPanel(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [workbench.showAiPanel, workbench.setShowAiPanel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:ai-panel-width", String(Math.round(aiPanelWidth)));
  }, [aiPanelWidth]);

  useEffect(() => {
    const syncWidth = () => {
      const containerWidth = workspaceRef.current?.clientWidth || 0;
      setAiPanelWidth((current) => clampAiPanelWidth(current, containerWidth));
    };

    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, []);

  useEffect(() => {
    if (!isAiPanelResizing) {
      return undefined;
    }

    const onMouseMove = (event) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const nextWidth = rect.right - event.clientX;
      setAiPanelWidth(clampAiPanelWidth(nextWidth, rect.width));
    };

    const onMouseUp = () => {
      setIsAiPanelResizing(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isAiPanelResizing]);

  return (
    <div className="app-shell flex h-full w-full min-h-0 flex-col overflow-hidden text-text">
      <AppWorkspace
        workbench={workbench}
        ui={{
          sidebarCollapsed,
          onToggleSidebarCollapsed: () => setSidebarCollapsed((prev) => !prev),
          onOpenSshConfig: () => setIsSshModalOpen(true),
          onOpenScriptConfig: () => setIsScriptModalOpen(true),
          onOpenWallpaperPicker: () => setIsWallpaperModalOpen(true),
          onOpenAiConfig: () => setIsAiModalOpen(true),
          workspaceRef,
          aiPanelWidth,
          isAiPanelResizing,
          onStartAiPanelResize: () => setIsAiPanelResizing(true),
          isFileEditorOpen,
          onOpenFileEditor: () => setIsFileEditorOpen(true),
          onCloseFileEditor: () => setIsFileEditorOpen(false),
        }}
      />

      <AppModals
        workbench={workbench}
        modalState={{
          isSshModalOpen,
          onCloseSshModal: () => setIsSshModalOpen(false),
          isScriptModalOpen,
          onCloseScriptModal: () => setIsScriptModalOpen(false),
          isAiModalOpen,
          onCloseAiModal: () => setIsAiModalOpen(false),
          isWallpaperModalOpen,
          onCloseWallpaperModal: () => setIsWallpaperModalOpen(false),
        }}
      />
    </div>
  );
}

export default App;
