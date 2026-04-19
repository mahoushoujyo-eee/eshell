import { useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import {
  pendingRiskBadgeClass,
  pendingRiskLabel,
} from "./aiAssistantUtils";

export default function AiPendingActionsPanel({
  pendingActions,
  resolvingActionId,
  onResolvePendingAction,
}) {
  const { t } = useI18n();
  const [commentsByActionId, setCommentsByActionId] = useState(() => ({}));
  const pendingRows = pendingActions.filter((action) => action?.status === "pending");

  if (pendingRows.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-warning/20 bg-warning/8 px-3 py-2">
      <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-warning">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        {t("Pending tool approvals")}
      </div>
      <div className="max-h-32 space-y-2 overflow-auto">
        {pendingRows.map((action) => {
          const busy = resolvingActionId === action.id;
          const riskLevel = pendingRiskLabel(action.riskLevel);
          const comment = commentsByActionId[action.id] || "";
          return (
            <div
              key={action.id}
              className="rounded-2xl border border-warning/30 bg-warning/10 p-2 text-[11px]"
            >
              <div className="mb-1 flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">
                  {action.command}
                </div>
                <span
                  className={[
                    "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                    pendingRiskBadgeClass(riskLevel),
                  ].join(" ")}
                >
                  {t(riskLevel)}
                </span>
              </div>
              <div className="mb-2 truncate text-muted">{t(action.reason || "no reason")}</div>
              <textarea
                value={comment}
                disabled={busy}
                placeholder={t("Add guidance for the agent after this decision (optional)")}
                className="mb-2 min-h-18 w-full rounded-xl border border-warning/25 bg-panel/82 px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-muted/70 disabled:opacity-50"
                onChange={(event) =>
                  setCommentsByActionId((current) => ({
                    ...current,
                    [action.id]: event.target.value,
                  }))
                }
              />
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-xl border border-success/50 bg-success/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                  onClick={() => onResolvePendingAction(action.id, true, comment)}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {t("Approve")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-xl border border-danger/50 bg-danger/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                  onClick={() => onResolvePendingAction(action.id, false, comment)}
                >
                  <X className="h-3.5 w-3.5" />
                  {t("Reject")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
