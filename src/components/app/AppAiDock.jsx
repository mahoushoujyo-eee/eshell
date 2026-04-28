import AiAssistantPanel from "../panels/AiAssistantPanel";
import { useI18n } from "../../lib/i18n";

export default function AppAiDock({
  workbench,
  showAiPanel,
  aiPanelWidth,
  isAiPanelResizing,
  onStartAiPanelResize,
  onOpenAiConfig,
}) {
  const { t } = useI18n();
  const {
    aiProfiles,
    activeAiProfileId,
    aiConfig,
    aiQuestion,
    setAiQuestion,
    aiShellContext,
    aiImageAttachments,
    aiConversations,
    activeAiConversationId,
    activeAiConversation,
    aiPendingActions,
    isAiStreaming,
    aiStreamingText,
    aiStreamingToolCalls,
    aiStreamingAgentProgress,
    activeAiConversationError,
    clearActiveAiConversationError,
    resolvingAiActionId,
    selectAiProfile,
    selectAiConversation,
    createAiConversation,
    deleteAiConversation,
    compactAiConversation,
    resolveAiPendingAction,
    askAi,
    cancelAiStreaming,
    saveAiApprovalMode,
    attachAiImages,
    removeAiImageAttachment,
    clearAiImageAttachments,
    clearAiShellContext,
    setShowAiPanel,
  } = workbench;

  return (
    <>
      <button
        type="button"
        aria-label={t("Resize AI panel")}
        className={[
          "relative shrink-0 bg-border/80 transition-colors",
          showAiPanel
            ? "w-1.5 cursor-col-resize hover:bg-accent/80"
            : "pointer-events-none w-0 opacity-0",
        ].join(" ")}
        onMouseDown={onStartAiPanelResize}
      />

      <div
        className={[
          "min-h-0 shrink-0 overflow-hidden border-l border-border/80 bg-panel transition-[width,opacity] ease-out",
          isAiPanelResizing ? "duration-0" : "duration-300",
          showAiPanel ? "opacity-100" : "w-0 opacity-0",
        ].join(" ")}
        style={{ width: showAiPanel ? `${aiPanelWidth}px` : "0px" }}
        aria-hidden={!showAiPanel}
      >
        <div className="h-full" style={{ width: `${aiPanelWidth}px` }}>
          <AiAssistantPanel
            aiProfiles={aiProfiles}
            activeAiProfileId={activeAiProfileId}
            approvalMode={aiConfig.approvalMode}
            onSelectAiProfile={selectAiProfile}
            onSaveApprovalMode={saveAiApprovalMode}
            conversations={aiConversations}
            activeConversationId={activeAiConversationId}
            activeConversation={activeAiConversation}
            onCreateConversation={createAiConversation}
            onSelectConversation={selectAiConversation}
            onDeleteConversation={deleteAiConversation}
            onCompactConversation={compactAiConversation}
            pendingActions={aiPendingActions}
            onResolvePendingAction={resolveAiPendingAction}
            resolvingActionId={resolvingAiActionId}
            aiQuestion={aiQuestion}
            setAiQuestion={setAiQuestion}
            shellContext={aiShellContext}
            aiImageAttachments={aiImageAttachments}
            onAttachAiImages={attachAiImages}
            onRemoveAiImageAttachment={removeAiImageAttachment}
            onClearAiImageAttachments={clearAiImageAttachments}
            onClearShellContext={clearAiShellContext}
            isStreaming={isAiStreaming}
            streamingText={aiStreamingText}
            streamingToolCalls={aiStreamingToolCalls}
            streamingAgentProgress={aiStreamingAgentProgress}
            conversationError={activeAiConversationError}
            onClearConversationError={clearActiveAiConversationError}
            onAskAi={askAi}
            onCancelStreaming={cancelAiStreaming}
            onOpenAiConfig={onOpenAiConfig}
            onClose={() => setShowAiPanel(false)}
            variant="dock"
          />
        </div>
      </div>
    </>
  );
}
