import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { groupOpsAgentMessages } from "../../../lib/ops-agent-message-rendering";
import { api } from "../../../lib/tauri-api";
import AiAgentTurn from "./AiAgentTurn";
import AiImageViewer from "./AiImageViewer";
import { copyText } from "./aiAssistantUtils";
import AiUserMessage from "./AiUserMessage";

const AUTO_SCROLL_THRESHOLD_PX = 40;

export default function AiMessageList({
  messages,
  activeConversationId,
  pendingActions,
  isStreaming,
  streamingText,
  streamingToolCalls,
  isDrawer,
  resolvingActionId,
  onResolvePendingAction,
}) {
  const { t } = useI18n();
  const messageGroups = groupOpsAgentMessages(messages, {
    conversationId: activeConversationId,
    pendingActions,
    isStreaming,
    streamingText,
    streamingToolCalls,
  });
  const hasContent = messageGroups.length > 0;
  const messageScrollRef = useRef(null);
  const [expandedShellMessageIds, setExpandedShellMessageIds] = useState(() => ({}));
  const [expandedToolMessageIds, setExpandedToolMessageIds] = useState(() => ({}));
  const [expandedThinkKeys, setExpandedThinkKeys] = useState(() => ({}));
  const [copiedMessageKey, setCopiedMessageKey] = useState(null);
  const [imageViewer, setImageViewer] = useState(null);
  const copyFeedbackTimerRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const activeConversationIdRef = useRef(activeConversationId);
  const attachmentCacheRef = useRef(new Map());

  useLayoutEffect(() => {
    const node = messageScrollRef.current;
    if (!node) {
      return;
    }
    if (activeConversationIdRef.current !== activeConversationId) {
      activeConversationIdRef.current = activeConversationId;
      shouldStickToBottomRef.current = true;
      node.scrollTop = node.scrollHeight;
      return;
    }
    if (!shouldStickToBottomRef.current) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [messages, pendingActions, isStreaming, streamingText, streamingToolCalls, activeConversationId]);

  useEffect(() => {
    setExpandedShellMessageIds({});
    setExpandedToolMessageIds({});
    setExpandedThinkKeys({});
    setCopiedMessageKey(null);
    setImageViewer(null);
    attachmentCacheRef.current.clear();
  }, [activeConversationId]);

  useEffect(() => {
    const node = messageScrollRef.current;
    if (!node) {
      return undefined;
    }

    const updateStickiness = () => {
      const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      shouldStickToBottomRef.current = distanceToBottom <= AUTO_SCROLL_THRESHOLD_PX;
    };

    updateStickiness();
    node.addEventListener("scroll", updateStickiness, { passive: true });
    return () => node.removeEventListener("scroll", updateStickiness);
  }, [activeConversationId]);

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  const handleCopyMessage = async (messageKey, content) => {
    try {
      const copied = await copyText(content);
      if (!copied) {
        return;
      }

      setCopiedMessageKey(messageKey);
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedMessageKey((current) => (current === messageKey ? null : current));
        copyFeedbackTimerRef.current = null;
      }, 1800);
    } catch (error) {
      console.error("copy ai message failed", error);
    }
  };

  const handleOpenImageAttachment = async (attachmentId, label) => {
    if (!attachmentId) {
      return;
    }

    const cachedAttachment = attachmentCacheRef.current.get(attachmentId);
    if (cachedAttachment) {
      setImageViewer({
        attachmentId,
        label,
        loading: false,
        error: "",
        attachment: cachedAttachment,
      });
      return;
    }

    setImageViewer({
      attachmentId,
      label,
      loading: true,
      error: "",
      attachment: null,
    });

    try {
      const attachment = await api.opsAgentGetAttachmentContent(attachmentId);
      attachmentCacheRef.current.set(attachmentId, attachment);
      setImageViewer((current) =>
        current?.attachmentId === attachmentId
          ? {
              attachmentId,
              label,
              loading: false,
              error: "",
              attachment,
            }
          : current,
      );
    } catch (error) {
      const errorMessage =
        typeof error === "string"
          ? error
          : error?.message || t("Failed to load image");
      setImageViewer((current) =>
        current?.attachmentId === attachmentId
          ? {
              attachmentId,
              label,
              loading: false,
              error: errorMessage,
              attachment: null,
            }
          : current,
      );
    }
  };

  return (
    <div
      ref={messageScrollRef}
      className={[
        "min-h-0 flex-1 overflow-auto px-3 py-3",
        isDrawer ? "bg-transparent" : "bg-surface/12",
      ].join(" ")}
    >
      {!hasContent ? (
        <div className="flex h-full flex-col items-center justify-center text-center text-xs text-muted">
          <span className="max-w-[18rem] leading-6">
            {t("Start a conversation about ops troubleshooting, diagnostics, or safe command planning.")}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {messageGroups.map((group) =>
            group.kind === "agent_turn" ? (
              <AiAgentTurn
                key={group.id}
                group={group}
                isDrawer={isDrawer}
                copiedMessageKey={copiedMessageKey}
                expandedThinkKeys={expandedThinkKeys}
                expandedToolMessageIds={expandedToolMessageIds}
                resolvingActionId={resolvingActionId}
                onCopyMessage={handleCopyMessage}
                onResolvePendingAction={onResolvePendingAction}
                onToggleThinkSection={(sectionKey) =>
                  setExpandedThinkKeys((current) => ({
                    ...current,
                    [sectionKey]: !current[sectionKey],
                  }))
                }
                onToggleToolMessage={(messageId) =>
                  setExpandedToolMessageIds((current) => ({
                    ...current,
                    [messageId]: !current[messageId],
                  }))
                }
              />
            ) : (
              <AiUserMessage
                key={group.id}
                group={group}
                isDrawer={isDrawer}
                expandedShellMessageIds={expandedShellMessageIds}
                openingAttachmentId={imageViewer?.loading ? imageViewer.attachmentId : ""}
                onOpenImageAttachment={handleOpenImageAttachment}
                onToggleShellContextMessage={(messageId) =>
                  setExpandedShellMessageIds((current) => ({
                    ...current,
                    [messageId]: !current[messageId],
                  }))
                }
              />
            ),
          )}
        </div>
      )}
      <AiImageViewer viewerState={imageViewer} onClose={() => setImageViewer(null)} />
    </div>
  );
}
