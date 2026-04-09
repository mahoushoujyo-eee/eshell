import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import {
  pendingRiskBadgeClass,
  pendingRiskLabel,
} from "./aiAssistantUtils";

export default function AiPendingActionsPanel({
  pendingActions,
  resolvingActionId,
  onResolvePendingAction,
}) {
  if (pendingActions.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-border/70 bg-[#fff7e8] px-3 py-2">
      <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-[#8a5a00]">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        Pending tool approvals
      </div>
      <div className="max-h-32 space-y-2 overflow-auto">
        {pendingActions.map((action) => {
          const busy = resolvingActionId === action.id;
          const riskLevel = pendingRiskLabel(action.riskLevel);
          return (
            <div
              key={action.id}
              className="rounded-2xl border border-[#efc77a] bg-[#fff3d8] p-2 text-[11px]"
            >
              <div className="mb-1 flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#5f3e00]">
                  {action.command}
                </div>
                <span
                  className={[
                    "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                    pendingRiskBadgeClass(riskLevel),
                  ].join(" ")}
                >
                  {riskLevel}
                </span>
              </div>
              <div className="mb-2 truncate text-[#8a5a00]">{action.reason || "no reason"}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-xl border border-success/50 bg-success/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                  onClick={() => onResolvePendingAction(action.id, true)}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-xl border border-danger/50 bg-danger/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                  onClick={() => onResolvePendingAction(action.id, false)}
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
