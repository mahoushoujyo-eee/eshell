import { Plus, Waypoints } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import Button from "../../components/ui/Button";
import ForwardCreateDialog from "./components/ForwardCreateDialog";
import ForwardRow from "./components/ForwardRow";

/**
 * The port-forward panel.
 *
 * Forwards are per shell tab, so an empty state here means "this tab has none"
 * rather than "there are none" — the copy says so, because the same panel on
 * another tab can be showing a different list.
 */
export default function ForwardPanel({
  activeSessionId,
  sessionForwards,
  createOpen,
  setCreateOpen,
  createBusy,
  stoppingId,
  loadError,
  createForward,
  stopForward,
  forgetForward,
}) {
  const { t } = useI18n();
  const rows = Array.isArray(sessionForwards) ? sessionForwards : [];
  const canCreate = Boolean(activeSessionId);

  const handleCreate = async (input) => {
    const created = await createForward(input);
    if (created) {
      setCreateOpen(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel text-xs">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <Waypoints className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted">
          {t("Port forwards")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setCreateOpen(true)}
          disabled={!canCreate}
          title={canCreate ? t("New port forward") : t("Connect SSH first")}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("New")}
        </Button>
      </div>

      <div className="scroll-region min-h-0 flex-1 overflow-auto px-1 py-1">
        {!canCreate ? (
          <div className="py-8 text-center text-[11px] text-subtle">{t("Connect SSH first")}</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-subtle">
            {t("No port forwards for this session")}
          </div>
        ) : (
          rows.map((forward) => (
            <ForwardRow
              key={forward.id}
              forward={forward}
              stopping={stoppingId === forward.id}
              onStop={stopForward}
              onForget={forgetForward}
            />
          ))
        )}
        {loadError ? (
          <div className="px-1.5 py-2 text-[11px] text-danger">
            {String(loadError?.message || loadError)}
          </div>
        ) : null}
      </div>

      <ForwardCreateDialog
        open={createOpen}
        busy={createBusy}
        onCancel={() => {
          if (!createBusy) {
            setCreateOpen(false);
          }
        }}
        onConfirm={handleCreate}
      />
    </div>
  );
}
