/**
 * Helpers for ACP session config options (model, thought level, ...).
 *
 * Shape on the wire (forwarded verbatim from the agent):
 *   { id, name, description?, category?, type: "select", currentValue, options }
 *   { id, name, description?, category?, type: "boolean", currentValue }
 *
 * `options` is an untagged union: either a flat list of
 * `{ value, name, description? }` or a list of groups
 * `{ group, name, options: [...] }`.
 *
 * Categories observed in practice:
 *   Codex       : mode, collaboration_mode, model, thought_level, model_config
 *   Claude Code : mode, model, thought_level, plus a fourth that VARIES with the
 *                 selected model — `model_config` (fast mode) on Opus, an
 *                 uncategorized `agent` persona selector on a custom model.
 * So the set is dynamic per session state, not a fixed per-agent list; that is
 * why `ConfigOptionUpdate` ships the whole set on every change and why this
 * module filters by category instead of by option id.
 */

export const CONFIG_CATEGORY_MODE = "mode";
export const CONFIG_CATEGORY_MODEL = "model";
export const CONFIG_CATEGORY_MODEL_CONFIG = "model_config";
export const CONFIG_CATEGORY_THOUGHT_LEVEL = "thought_level";

/**
 * Categories the settings menu surfaces, in display order.
 *
 * Deliberately a whitelist, which decides three things:
 * - `mode` is excluded because every probed agent mirrors `SessionModeState`
 *   there, and the panel already drives that through `session/set_mode`; showing
 *   both would mean two identical mode selectors.
 * - `model_config` is excluded by product decision: it is where both agents put
 *   "fast mode", which is not worth the menu row.
 * - Unknown and absent categories are excluded as noise — that covers Codex's
 *   `collaboration_mode` and Claude Code's `agent` persona selector.
 *
 * None of this affects correctness: the agent keeps its own value for anything
 * not shown. This list is the single place to edit to surface a category again.
 */
const DISPLAY_CATEGORIES = [CONFIG_CATEGORY_MODEL, CONFIG_CATEGORY_THOUGHT_LEVEL];

/** Config options the settings menu shows, in display order. */
export function visibleConfigOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  const usable = options.filter(
    (option) =>
      option &&
      typeof option.id === "string" &&
      option.id.length > 0 &&
      DISPLAY_CATEGORIES.includes(option.category),
  );
  const rank = (option) => DISPLAY_CATEGORIES.indexOf(option.category);
  // Stable: equal ranks keep the agent's ordering.
  return usable
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
    .map((entry) => entry.option);
}

/** Normalizes a select option's choices into groups (ungrouped becomes one unnamed group). */
export function configSelectGroups(option) {
  const raw = Array.isArray(option?.options) ? option.options : [];
  if (raw.length === 0) {
    return [];
  }
  const grouped = raw.every((entry) => entry && Array.isArray(entry.options));
  if (!grouped) {
    return [{ group: null, name: null, options: raw.filter(Boolean) }];
  }
  return raw.map((group) => ({
    group: group.group ?? null,
    name: group.name ?? null,
    options: Array.isArray(group.options) ? group.options.filter(Boolean) : [],
  }));
}

/** Flat list of a select option's choices, across groups. */
export function configSelectValues(option) {
  return configSelectGroups(option).flatMap((group) => group.options);
}

/**
 * Short label for the option's current value, used on the trigger pill.
 * Falls back to the raw value when the agent reports a current value that is
 * not among the advertised choices.
 */
export function configOptionCurrentLabel(option) {
  if (!option) {
    return "";
  }
  if (option.type === "boolean") {
    return option.currentValue ? "On" : "Off";
  }
  const match = configSelectValues(option).find((value) => value.value === option.currentValue);
  return match?.name || String(option.currentValue ?? "");
}
