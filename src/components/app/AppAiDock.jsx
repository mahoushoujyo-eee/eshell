import AcpAgentPanel from "../panels/AcpAgentPanel";
import { useI18n } from "../../lib/i18n";

export default function AppAiDock({
  acp,
  showAiPanel,
  aiPanelWidth,
  isAiPanelResizing,
  onStartAiPanelResize,
  onClose,
}) {
  const { t } = useI18n();

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
          <AcpAgentPanel acp={acp} onClose={onClose} />
        </div>
      </div>
    </>
  );
}
