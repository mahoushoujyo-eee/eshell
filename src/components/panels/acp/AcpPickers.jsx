import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
    "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors duration-150",
    disabled
      ? "cursor-default border-transparent text-muted"
      : open
        ? "border-border-strong bg-hover text-text"
        : "border-transparent text-text hover:bg-hover",
  ].join(" ");

const optionClass = (selected) =>
  [
    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
    selected ? "bg-accent-soft text-text" : "text-text/90 hover:bg-hover",
  ].join(" ");

// Small green dot marking an agent whose process is already running.
function RunningDot({ title }) {
  return (
    <span title={title} className="h-1.5 w-1.5 shrink-0 rounded-full bg-success ring-2 ring-success/20" />
  );
}

/**
 * Panel-wide positioning layer for one menu, or for a menu plus the column it
 * drives (list left, values right — DOM order is reading order, so tab order
 * follows too). `align` picks the side of the dock the group hugs; `inset`
 * shifts it off that edge by the trigger's `offsetLeft`, for a trigger that does
 * not sit flush against one.
 *
 * The layer itself is click-transparent (`pointer-events-none`) and only the
 * menu group opts back in. It is a full-width box spanning the whole menu area,
 * and it lives inside the composer, so without this any click on the empty space
 * around a menu reads as "inside the composer" and the panel's outside-click
 * dismiss never fires — the menu would only ever close from its own trigger.
 * The opt-in sits on the group rather than on each panel so that the gap
 * between a list and the column it drives stays part of the menu.
 */
function MenuLayer({ side = "top", align = "start", inset = 0, children }) {
  return (
    <div
      style={inset ? { paddingLeft: inset } : undefined}
      className={[
        "pointer-events-none absolute inset-x-0 z-30 flex items-end",
        side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        align === "end" ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      <div className="pointer-events-auto flex min-w-0 items-end gap-1.5">{children}</div>
    </div>
  );
}

/**
 * One bordered menu box with roving focus. `autoFocus` is off for a secondary
 * column that follows the pointer — pulling focus there would fight the pointer.
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
        "overflow-hidden rounded-lg border border-border bg-elevated shadow-overlay",
        className,
      ].join(" ")}
    >
      <div className="px-3 pt-2.5 pb-1 text-[10.5px] font-medium tracking-[0.08em] text-subtle uppercase">
        {label}
      </div>
      <div
        ref={listRef}
        onKeyDown={handleKeyDown}
        className="scroll-region max-h-72 space-y-0.5 overflow-y-auto px-1 pb-1"
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
 * value; the rows are the left column and the highlighted row's values are the
 * right one, so the combinatorial settings stay one click deep without a row of
 * pills.
 *
 * The value column is always populated — the first row with values by default,
 * otherwise whichever row was last hovered or focused. It is never a separate
 * panel that pops in and out on hover: that left the menu half-collapsed (list
 * hanging alone) whenever the pointer strayed off the values, and made the
 * whole group jump sideways every time a row was touched.
 */
export function AcpSessionSettingsMenu({ options, open, onToggle, onSelect }) {
  const { t } = useI18n();
  const [detailId, setDetailId] = useState(null);
  const [inset, setInset] = useState(0);
  const triggerRef = useRef(null);

  // The layer spans the whole composer (a trigger-anchored popover gets clipped
  // by the 320-760px dock), so it is inset to the trigger to still read as that
  // button's popover — this pill sits after the session-mode pill, not at the
  // composer's left edge. `offsetLeft` shares the layer's coordinate origin
  // (both are relative to the composer footer). Re-measured on every render
  // while open, so a wrapped pill row or a resized dock self-corrects; the
  // equality check stops it from looping.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const next = triggerRef.current?.offsetLeft ?? 0;
    setInset((prev) => (prev === next ? prev : next));
  });

  if (options.length === 0) {
    return null;
  }

  // Falls back to the first row that has values when nothing was touched yet, or
  // when the touched row is gone (a model switch can swap the whole option set).
  const detail =
    options.find((option) => option.id === detailId && option.type !== "boolean") ||
    options.find((option) => option.type !== "boolean") ||
    null;
  const labels = options.map((option) => configOptionCurrentLabel(option));
  const summary = options
    .map((option, index) => `${option.name}: ${labels[index]}`)
    .join(" · ");

  return (
    <>
      <button
        ref={triggerRef}
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
        {/* The current values, not just a gear: the two settings that matter are
            otherwise invisible until the menu is opened. Model names run long
            (`deepseek-v4-flash-vision-exp[1m]`), so the strip truncates and the
            full "Name: value" list stays in the tooltip. */}
        <span className="min-w-0 max-w-[14rem] truncate">{labels.join(" · ")}</span>
        <ChevronDown
          className={["h-3.5 w-3.5 shrink-0 text-muted transition-transform", open ? "rotate-180" : ""].join(
            " ",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <MenuLayer side="top" align="start" inset={inset}>
          <MenuPanel label={t("Session settings")} className="w-[13rem] min-w-0 shrink">
            {options.map((option) => {
              const isBoolean = option.type === "boolean";
              const shown = !isBoolean && option.id === detail?.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-haspopup={isBoolean ? undefined : "listbox"}
                  aria-expanded={isBoolean ? undefined : shown}
                  aria-pressed={isBoolean ? Boolean(option.currentValue) : undefined}
                  title={option.description || option.name}
                  onMouseEnter={() => {
                    if (!isBoolean) {
                      setDetailId(option.id);
                    }
                  }}
                  onFocus={() => {
                    if (!isBoolean) {
                      setDetailId(option.id);
                    }
                  }}
                  onClick={() =>
                    isBoolean ? onSelect(option.id, !option.currentValue) : setDetailId(option.id)
                  }
                  className={optionClass(shown)}
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

          {detail ? (
            <MenuPanel
              label={detail.name}
              autoFocus={false}
              className="w-[15rem] min-w-0 shrink"
            >
              {configSelectGroups(detail).map((group, groupIndex) => (
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
                      selected={value.value === detail.currentValue}
                      onSelect={() => onSelect(detail.id, value.value)}
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
