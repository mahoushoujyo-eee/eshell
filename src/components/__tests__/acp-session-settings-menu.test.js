/**
 * Static markup of the ACP session-settings menu (model / thought level).
 *
 * Rendered with `renderToStaticMarkup` in the node Vitest environment: no DOM,
 * so hover and focus never happen and the menu is pinned in its *untouched*
 * state — which is exactly the state that used to be broken. The value column
 * was a hover-only flyout, so an untouched menu rendered the option list alone
 * and the list's values showed up only once the pointer happened to cross a row.
 *
 * What is pinned:
 *   - The trigger spells out the current values, not just a gear.
 *   - The menu is one two-column unit: the option list, then that option's
 *     values, both present before any interaction.
 *   - Only the highlighted row's values are rendered (exactly one value column).
 *   - The list comes first in `flex-row` order, i.e. list on the left, values on
 *     the right (`flex-row-reverse` is the regression).
 *   - The positioning layer is click-transparent and only the menu group opts
 *     back in, so clicks on the empty space around the menu reach the panel's
 *     outside-click dismiss instead of counting as "inside the composer".
 *   - A boolean-only option set renders no value column instead of crashing.
 */
import { describe, expect, it } from "vitest";
import * as ReactDOMServer from "react-dom/server";
import { createElement } from "react";
import { AcpSessionSettingsMenu } from "../panels/acp/AcpPickers";

const SELECT_OPTIONS = [
  {
    id: "model",
    name: "Model",
    description: "Which model to run",
    category: "model",
    type: "select",
    currentValue: "opus",
    options: [
      { value: "opus", name: "Opus", description: "Most capable" },
      { value: "sonnet", name: "Sonnet" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low effort" },
      { value: "high", name: "High effort" },
    ],
  },
];

const render = (options) =>
  ReactDOMServer.renderToStaticMarkup(
    createElement(AcpSessionSettingsMenu, { options, open: true, onToggle() {}, onSelect() {} }),
  );

describe("AcpSessionSettingsMenu markup", () => {
  it("shows the current model and effort on the trigger", () => {
    const markup = render(SELECT_OPTIONS);
    const trigger = markup.slice(0, markup.indexOf("<div"));

    expect(trigger).toContain("Opus");
    expect(trigger).toContain("High effort");
    // The visible text is values only, so the label keeps the control's meaning.
    expect(trigger).toContain('aria-label="Session settings"');
  });

  it("renders the list and the first row's values side by side with nothing touched", () => {
    const markup = render(SELECT_OPTIONS);

    // The list: one row per option, each showing its current value.
    expect(markup).toContain("Model");
    expect(markup).toContain("Effort");
    expect(markup).toContain("Opus");

    // The value column defaults to the first select row (model).
    expect(markup).toContain("Sonnet");
    expect(markup).toContain("Most capable");

    // Only one value column exists, so the other row's values are not rendered:
    // "High effort" shows up once, as the effort row's current value, never as a
    // selectable option row of its own. (The trigger's `title` summary carries
    // the string too, hence matching on the row markup rather than the text.)
    expect(markup).not.toContain("Low effort");
    expect(markup.match(/>High effort</g)).toHaveLength(1);
  });

  it("puts the list on the left of the value column", () => {
    const markup = render(SELECT_OPTIONS);

    expect(markup).not.toContain("flex-row-reverse");
    // The list's panel header precedes the value rows of the column beside it.
    expect(markup.indexOf("Session settings</div>")).toBeLessThan(
      markup.indexOf("Most capable"),
    );
    expect(markup.indexOf("Most capable")).toBeLessThan(markup.indexOf("Sonnet"));
  });

  it("lets clicks outside the menu group fall through to the panel", () => {
    const markup = render(SELECT_OPTIONS);

    expect(markup).toContain("pointer-events-none absolute inset-x-0 z-30");
    expect(markup).toContain("pointer-events-auto flex min-w-0 items-end");
  });

  it("renders no value column when every option is a boolean", () => {
    const markup = render([
      {
        id: "fast-mode",
        name: "Fast",
        category: "model_config",
        type: "boolean",
        currentValue: true,
      },
    ]);

    expect(markup).toContain("Fast");
    expect(markup).toContain("On");
  });
});
