import { Bot } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export default function AiAssistantProfileBar({
  hasManagedShell,
  aiProfiles,
  activeAiProfileId,
  onSelectAiProfile,
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-3">
      {!hasManagedShell ? (
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("Ops Agent")}
        </div>
      ) : (
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
          {t("Model")}
        </span>
      )}
      <select
        className={[
          "min-w-0 border border-border/75 bg-surface/75 px-3 py-2 text-xs outline-none",
          hasManagedShell ? "ml-auto max-w-[72%] rounded-xl" : "ml-auto max-w-[60%]",
        ].join(" ")}
        value={activeAiProfileId || ""}
        onChange={(event) => onSelectAiProfile(event.target.value)}
        disabled={aiProfiles.length === 0}
      >
        {aiProfiles.length === 0 ? (
          <option value="">{t("No AI profile")}</option>
        ) : (
          aiProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} / {profile.model}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
