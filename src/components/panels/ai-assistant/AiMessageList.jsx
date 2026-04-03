import { useEffect, useRef, useState } from "react";
import { groupOpsAgentMessages } from "../../../lib/ops-agent-message-rendering";
import AiAgentTurn from "./AiAgentTurn";
import { copyText } from "./aiAssistantUtils";
import AiUserMessage from "./AiUserMessage";

export default function AiMessageList({
  messages,
  activeConversationId,
  isStreaming,
  streamingText,
  isDrawer,
}) {
  const messageGroups = groupOpsAgentMessages(messages, { isStreaming, streamingText });
  const hasContent = messageGroups.length > 0;
  const messageScrollRef = useRef(null);
  const [expandedShellMessageIds, setExpandedShellMessageIds] = useState(() => ({}));
  const [expandedToolMessageIds, setExpandedToolMessageIds] = useState(() => ({}));
  const [expandedThinkKeys, setExpandedThinkKeys] = useState(() => ({}));
  const [copiedMessageKey, setCopiedMessageKey] = useState(null);
  const copyFeedbackTimerRef = useRef(null);

  useEffect(() => {
    const node = messageScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [messages, isStreaming, streamingText, activeConversationId]);

  useEffect(() => {
    setExpandedShellMessageIds({});
    setExpandedToolMessageIds({});
    setExpandedThinkKeys({});
    setCopiedMessageKey(null);
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
            Start a conversation about ops troubleshooting, diagnostics, or safe command planning.
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
                onCopyMessage={handleCopyMessage}
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
    </div>
  );
}
