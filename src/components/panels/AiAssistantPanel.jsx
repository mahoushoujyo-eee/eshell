import { useEffect, useState } from "react";
import AiAssistantHeader from "./ai-assistant/AiAssistantHeader";
import AiAssistantProfileBar from "./ai-assistant/AiAssistantProfileBar";
import AiComposer from "./ai-assistant/AiComposer";
import AiConversationErrorBanner from "./ai-assistant/AiConversationErrorBanner";
import AiConversationHistory from "./ai-assistant/AiConversationHistory";
import AiMessageList from "./ai-assistant/AiMessageList";
import AiPendingActionsPanel from "./ai-assistant/AiPendingActionsPanel";
import DeleteConversationDialog from "./ai-assistant/DeleteConversationDialog";

export default function AiAssistantPanel({
  aiProfiles,
  activeAiProfileId,
  approvalMode,
  onSelectAiProfile,
  onSaveApprovalMode,
  conversations,
  activeConversationId,
  activeConversation,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
  onCompactConversation,
  pendingActions,
  onResolvePendingAction,
  resolvingActionId,
  aiQuestion,
  setAiQuestion,
  shellContext,
  onClearShellContext,
  isStreaming,
  streamingText,
  streamingToolCalls = [],
  conversationError = "",
  onClearConversationError,
  onAskAi,
  onCancelStreaming,
  onOpenAiConfig,
  onClose,
  variant = "panel",
}) {
  const isDrawer = variant === "drawer";
  const isDock = variant === "dock";
  const hasManagedShell = isDrawer || isDock;
  const historyPanelWidth = hasManagedShell ? 184 : 208;
  const conversationErrorText = String(conversationError || "").trim();
  const messages = activeConversation?.messages || [];
  const [historyVisible, setHistoryVisible] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.localStorage.getItem("eshell:ai-history-visible") !== "0";
  });
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState(null);
  const [deleteConversationBusyId, setDeleteConversationBusyId] = useState("");
  const [compactConversationBusyId, setCompactConversationBusyId] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:ai-history-visible", historyVisible ? "1" : "0");
  }, [historyVisible]);

  useEffect(() => {
    setPendingDeleteConversation(null);
    setDeleteConversationBusyId("");
    setCompactConversationBusyId("");
  }, [activeConversationId]);

  const requestDeleteConversation = (conversation) => {
    if (!conversation?.id) {
      return;
    }

    setPendingDeleteConversation({
      id: conversation.id,
      title: conversation.title || "",
    });
  };

  const closeDeleteConversationDialog = () => {
    if (deleteConversationBusyId) {
      return;
    }
    setPendingDeleteConversation(null);
  };

  const confirmDeleteConversation = async () => {
    const conversationId = pendingDeleteConversation?.id;
    if (!conversationId) {
      return;
    }

    setDeleteConversationBusyId(conversationId);
    try {
      const deleted = await onDeleteConversation(conversationId);
      if (deleted !== false) {
        setPendingDeleteConversation(null);
      }
    } finally {
      setDeleteConversationBusyId("");
    }
  };

  const deleteDialogBusy =
    Boolean(pendingDeleteConversation?.id) && deleteConversationBusyId === pendingDeleteConversation.id;

  const handleCompactConversation = async () => {
    if (!activeConversationId || !onCompactConversation) {
      return;
    }

    setCompactConversationBusyId(activeConversationId);
    try {
      await onCompactConversation(activeConversationId);
    } finally {
      setCompactConversationBusyId("");
    }
  };

  return (
    <div
      className={[
        "flex h-full min-h-0 flex-col overflow-hidden",
        isDrawer
          ? "rounded-[28px] border border-border/70 bg-surface/88 shadow-[0_28px_90px_rgba(6,10,14,0.34)] backdrop-blur-2xl ring-1 ring-white/6"
          : "bg-panel",
      ].join(" ")}
    >
      <AiAssistantHeader
        hasManagedShell={hasManagedShell}
        isDrawer={isDrawer}
        historyVisible={historyVisible}
        onToggleHistory={() => setHistoryVisible((current) => !current)}
        onCreateConversation={onCreateConversation}
        onCompactConversation={handleCompactConversation}
        compactBusy={Boolean(activeConversationId) && compactConversationBusyId === activeConversationId}
        canCompact={Boolean(activeConversationId) && !isStreaming}
        onOpenAiConfig={onOpenAiConfig}
        onClose={onClose}
      />

      <div className="flex min-h-0 flex-1">
        <AiConversationHistory
          historyVisible={historyVisible}
          historyPanelWidth={historyPanelWidth}
          isDrawer={isDrawer}
          hasManagedShell={hasManagedShell}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onCreateConversation={onCreateConversation}
          onSelectConversation={onSelectConversation}
          onRequestDeleteConversation={requestDeleteConversation}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
          <AiAssistantProfileBar
            hasManagedShell={hasManagedShell}
            aiProfiles={aiProfiles}
            activeAiProfileId={activeAiProfileId}
            onSelectAiProfile={onSelectAiProfile}
          />

          <AiPendingActionsPanel
            pendingActions={pendingActions}
            resolvingActionId={resolvingActionId}
            onResolvePendingAction={onResolvePendingAction}
          />

          <AiConversationErrorBanner
            conversationErrorText={conversationErrorText}
            onClearConversationError={onClearConversationError}
          />

          <AiMessageList
            messages={messages}
            activeConversationId={activeConversationId}
            pendingActions={pendingActions}
            isStreaming={isStreaming}
            streamingText={streamingText}
            streamingToolCalls={streamingToolCalls}
            isDrawer={isDrawer}
            resolvingActionId={resolvingActionId}
            onResolvePendingAction={onResolvePendingAction}
          />

          <AiComposer
            isDrawer={isDrawer}
            aiProfiles={aiProfiles}
            activeAiProfileId={activeAiProfileId}
            onSelectAiProfile={onSelectAiProfile}
            approvalMode={approvalMode}
            shellContext={shellContext}
            onClearShellContext={onClearShellContext}
            aiQuestion={aiQuestion}
            setAiQuestion={setAiQuestion}
            onAskAi={onAskAi}
            onCancelStreaming={onCancelStreaming}
            onSaveApprovalMode={onSaveApprovalMode}
            isStreaming={isStreaming}
            activeConversationId={activeConversationId}
            activeConversation={activeConversation}
            hasManagedShell={hasManagedShell}
            onClose={onClose}
          />
        </section>
      </div>

      <DeleteConversationDialog
        open={Boolean(pendingDeleteConversation)}
        conversationTitle={pendingDeleteConversation?.title || ""}
        busy={deleteDialogBusy}
        onCancel={closeDeleteConversationDialog}
        onConfirm={confirmDeleteConversation}
      />
    </div>
  );
}
