const FIELD_BASE =
  "min-w-0 rounded-md border border-border-strong bg-panel text-text outline-none transition-colors duration-150 placeholder:text-subtle hover:border-muted/50 focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-55";

export const inputClass = `${FIELD_BASE} h-8 w-full px-2.5 text-[13px]`;

/** Dense variant for panel toolbars. */
export const inputSmClass = `${FIELD_BASE} h-7 w-full px-2 text-xs`;

export const selectClass = `${FIELD_BASE} h-8 w-full px-2 text-[13px]`;

/** Dense select sized by its options; the caller sets a width if it needs one. */
export const selectSmClass = `${FIELD_BASE} h-7 px-1.5 text-xs`;

export const textareaClass = `${FIELD_BASE} w-full px-2.5 py-2 text-[13px] leading-relaxed`;

export const labelClass = "text-xs font-medium text-muted";

/** Small uppercase heading above a group of rows. */
export const sectionLabelClass = "text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase";
