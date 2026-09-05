import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Settings2, SlidersHorizontal } from "lucide-react";
import AcpAgentLogo from "../../ai/AcpAgentLogo";
import { formatAcpAgentSpawn } from "../../../lib/acpAgentBrands";
import { configOptionCurrentLabel, configSelectGroups } from "../../../lib/acpConfigOptions";
import { useI18n } from "../../../lib/i18n";

/**
 * Pickers for the ACP panel: the agent chooser in the header, and the
 * session-mode chooser plus the session-settings menu (model, thought level,
 * model config) in the composer footer.
 *
 * All are controlled by the panel, which keeps a single "which menu is open"
 * value so only one opens at a time and owns outside-click / Escape handling.
 *
 * Positioning: each menu is placed by a full-width [`MenuLayer`] rather than by
 * its trigger. The dock is only 320-760px wide and the panel root clips
 * overflow, so a popover pinned to a trigger near an edge gets cut off; a
 * panel-wide layer plus flex alignment keeps the menu beside its own button and
 * inside the panel at any width.
 */

const triggerClass = (open, disabled) =>
  [
    "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[12px]",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors",
    disabled
      ? "cursor-default border-border/40 bg-surface/50 text-muted"
      : open
        ? "border-accent/40 bg-surface text-text"
        : "border-border/55 bg-surface/82 text-text hover:border-accent/30 hover:bg-surface",
  ].join(" ");

const optionClass = (selected) =>
  [
    "flex w-full items-center gap-2.5 rounded-[12px] px-2 py-1.5 text-left transition-colors",
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
    selected
      ? "bg-surface/92 text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      : "text-text/88 hover:bg-surface/72",
  ].join(" ");

// Small green dot marking an agent whose process is already running.
function RunningDot({ title }) {
  return (
    <span
      title={title}
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-success shadow-[0_0_0_2px_rgba(62,143,87,0.18)]"
    />
  );
}

/**
 * Panel-wide positioning layer for one menu (or a menu plus its flyout).
 * `align` picks the side the trigger sits on; `reverse` right-aligns while
 * keeping DOM order primary-then-flyout, so tab order matches reading order.
 */
function MenuLayer({ side = "top", align = "start", reverse = false, onMouseLeave, children }) {
  return (
    <div
      onMouseLeave={onMouseLeave}
      className={[
        "absolute inset-x-0 z-30 flex items-end gap-1.5",
        side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        reverse ? "flex-row-reverse justify-start" : align === "end" ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * One bordered menu box with roving focus. `autoFocus` is off for flyouts, which
 * open on hover — pulling focus there would fight the pointer.
 */
function MenuPanel({ label, className = "", autoFocus = true, children }) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    const node = listRef.current;
    if (!node) {
      return;
    }
    const selected = node.querySelector('[aria-selected="true"], [aria-expanded="true"]');
    (selected || node.querySelector("button"))?.focus();
  }, [autoFocus]);

  const handleKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = Array.from(listRef.current?.querySelectorAll("button") || []);
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    let next;
    if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    } else {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    }
    items[next].focus();
  };

  return (
    <div
      className={[
        "overflow-hidden rounded-[16px] border border-border/70 bg-panel/97",
        "shadow-[0_18px_42px_rgba(0,0,0,0.22)] backdrop-blur-xl",
        className,
      ].join(" ")}
    >
      <div className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </div>
      <div
        ref={listRef}
        onKeyDown={handleKeyDown}
        className="max-h-72 space-y-0.5 overflow-y-auto px-1.5 pb-1.5"
      >
        {children}
      </div>
    </div>
  );
}

/** One selectable value row: name, optional clamped description, check mark. */
function ValueRow({ name, description, selected, onSelect }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`${optionClass(selected)} items-start`}
      data-tauri-no-drag
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{name}</span>
        {description ? (
          // Agent-authored and sometimes a full paragraph (Claude Code's persona
          // descriptions), so clamp rather than trusting them to be short.
          <span className="mt-0.5 line-clamp-3 block text-[10px] leading-snug text-muted">
            {description}
          </span>
        ) : null}
      </span>
      {selected ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      ) : null}
    </button>
  );
}

export function AcpAgentPicker({ agents, activeAgentId, locked, open, onToggle, onSelect }) {
  const { t } = useI18n();
  const activeAgent = agents.find((agent) => agent.id === activeAgentId) || null;
  const disabled = locked || agents.length === 0;

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          locked
            ? t("Stop the agent to switch")
            : activeAgent
              ? formatAcpAgentSpawn(activeAgent)
              : t("No agent configured")
        }
        className={triggerClass(open, disabled)}
        data-tauri-no-drag
      >
        <AcpAgentLogo agent={activeAgent} className="h-5 w-5" />
        <span className="min-w-0 truncate font-medium">
          {activeAgent?.name || t("No agent configured")}
        </span>
        {activeAgent?.running ? <RunningDot title={t("Agent process running")} /> : null}
        {disabled ? null : (
          <ChevronDown
            className={["h-3.5 w-3.5 shrink-0 text-muted transition-transform", open ? "rotate-180" : ""].join(
              " ",
            )}
            aria-hidden="true"
          />
        )}
      </button>

      {open ? (
        <MenuLayer side="bottom" align="start">
          <MenuPanel label={t("ACP Agent")} className="w-[17rem] min-w-0 shrink">
            {agents.map((agent) => {
              const selected = agent.id === activeAgentId;
              const spawn = formatAcpAgentSpawn(agent);
              return (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={spawn}
                  onClick={() => onSelect(agent.id)}
                  className={optionClass(selected)}
                  data-tauri-no-drag
                >
                  <AcpAgentLogo agent={agent} className="h-7 w-7" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{agent.name}</span>
                      {agent.running ? <RunningDot title={t("Agent process running")} /> : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
                      {spawn}
                    </span>
                  </span>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </MenuPanel>
        </MenuLayer>
      ) : null}
    </>
  );
}

export function AcpModePicker({ modes, open, onToggle, onSelect }) {
  const { t } = useI18n();
  const availableModes = modes?.availableModes || [];
  const activeMode =
    availableModes.find((mode) => mode.id === modes?.currentModeId) || availableModes[0] || null;

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeMode?.description || t("Session mode")}
        className={triggerClass(open, false)}
        data-tauri-no-drag
      >
        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 truncate">{activeMode?.name || t("Session mode")}</span>
        <ChevronDown
          className={["h-3.5 w-3.5 shrink-0 text-muted transition-transform", open ? "rotate-180" : ""].join(
            " ",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <MenuLayer side="top" align="start">
          <MenuPanel label={t("Session mode")} className="w-[16rem] min-w-0 shrink">
            {availableModes.map((mode) => (
              <ValueRow
                key={mode.id}
                name={mode.name}
                description={mode.description}
                selected={mode.id === modes?.currentModeId}
                onSelect={() => onSelect(mode.id)}
              />
            ))}
          </MenuPanel>
        </MenuLayer>
      ) : null}
    </>
  );
}

/**
 * Single settings button for every session config option the agent advertises
 * (model, thought level, model config). One row per option showing its current
 * value; hovering or focusing a select row flies its values out to the side, so
 * the combinatorial settings stay one click deep without a row of pills.
 */
export function AcpSessionSettingsMenu({ options, open, onToggle, onSelect }) {
  const { t } = useI18n();
  const [flyoutId, setFlyoutId] = useState(null);

  // A closed menu must not remember which row was open.
  useEffect(() => {
    if (!open) {
      setFlyoutId(null);
    }
  }, [open]);

  if (options.length === 0) {
    return null;
  }

  const flyout = options.find((option) => option.id === flyoutId) || null;
  const summary = options
    .map((option) => `${option.name}: ${configOptionCurrentLabel(option)}`)
    .join(" · ");

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={summary}
        aria-label={t("Session settings")}
        className={triggerClass(open, false)}
        data-tauri-no-drag
      >
        <Settings2 className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <ChevronDown
          className={["h-3.5 w-3.5 shrink-0 text-muted transition-transform", open ? "rotate-180" : ""].join(
            " ",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <MenuLayer side="top" reverse onMouseLeave={() => setFlyoutId(null)}>
          <MenuPanel label={t("Session settings")} className="w-[13rem] shrink-0">
            {options.map((option) => {
              const isBoolean = option.type === "boolean";
              const expanded = option.id === flyoutId;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-haspopup={isBoolean ? undefined : "listbox"}
                  aria-expanded={isBoolean ? undefined : expanded}
                  aria-pressed={isBoolean ? Boolean(option.currentValue) : undefined}
                  title={option.description || option.name}
                  onMouseEnter={() => setFlyoutId(isBoolean ? null : option.id)}
                  onFocus={() => setFlyoutId(isBoolean ? null : option.id)}
                  onClick={() =>
                    isBoolean
                      ? onSelect(option.id, !option.currentValue)
                      : setFlyoutId(expanded ? null : option.id)
                  }
                  className={optionClass(expanded)}
                  data-tauri-no-drag
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] uppercase tracking-[0.06em] text-muted">
                      {option.name}
                    </span>
                    <span className="block truncate text-[13px] font-medium">
                      {configOptionCurrentLabel(option)}
                    </span>
                  </span>
                  {isBoolean ? null : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </MenuPanel>

          {flyout ? (
            <MenuPanel
              label={flyout.name}
              autoFocus={false}
              className="w-[15rem] min-w-0 shrink"
            >
              {configSelectGroups(flyout).map((group, groupIndex) => (
                <div key={group.group ?? groupIndex}>
                  {group.name ? (
                    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
                      {group.name}
                    </div>
                  ) : null}
                  {group.options.map((value) => (
                    <ValueRow
                      key={value.value}
                      name={value.name}
                      description={value.description}
                      selected={value.value === flyout.currentValue}
                      onSelect={() => onSelect(flyout.id, value.value)}
                    />
                  ))}
                </div>
              ))}
            </MenuPanel>
          ) : null}
        </MenuLayer>
      ) : null}
    </>
  );
}
