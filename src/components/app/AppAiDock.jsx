import AcpAgentPanel from "../panels/AcpAgentPanel";
import { useI18n } from "../../lib/i18n";

export default function AppAiDock({
  acp,
  showAiPanel,
  aiPanelWidth,
  isAiPanelResizing,
  onStartAiPanelResize,
}) {
  const { t } = useI18n();

  return (
    <>
      <button
        type="button"
        aria-label={t("Resize AI panel")}
        className={[
          "relative z-10 shrink-0 transition-colors duration-150 before:absolute before:inset-y-0 before:-right-[3px] before:-left-[3px] before:content-['']",
          showAiPanel
            ? [
                "w-px cursor-col-resize hover:bg-accent/70",
                isAiPanelResizing ? "bg-accent/70" : "bg-border",
              ].join(" ")
            : "pointer-events-none w-0 opacity-0",
        ].join(" ")}
        onMouseDown={onStartAiPanelResize}
      />

      <div
        className={[
          "min-h-0 shrink-0 overflow-hidden bg-surface transition-[width,opacity] ease-out",
          isAiPanelResizing ? "duration-0" : "duration-200",
          showAiPanel ? "opacity-100" : "w-0 opacity-0",
        ].join(" ")}
        style={{ width: showAiPanel ? `${aiPanelWidth}px` : "0px" }}
        aria-hidden={!showAiPanel}
      >
        <div className="h-full" style={{ width: `${aiPanelWidth}px` }}>
          <AcpAgentPanel acp={acp} />
        </div>
      </div>
    </>
  );
}
