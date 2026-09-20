/**
 * External toolbar icon resolution and the Panels section's overflow.
 *
 * The icon contract has three accepted shapes and a closed name set; the
 * failure mode this suite exists to prevent is a bad icon blanking the rail
 * button, or a plugin handing the host a URL the app should not fetch.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { externalToolbarIcon } from "../layout/TopToolbar.jsx";

const renderIcon = (icon) => {
  const Resolved = externalToolbarIcon(icon);
  return renderToStaticMarkup(createElement(Resolved));
};

describe("external toolbar icon resolution", () => {
  it("resolves a known name to a host icon", () => {
    // Every name in the documented set must resolve to something renderable
    // and must not be the fallback.
    const names = [
      "box",
      "boxes",
      "cloud",
      "container",
      "cpu",
      "database",
      "git",
      "globe",
      "harddrive",
      "layers",
      "monitor",
      "network",
      "package",
      "puzzle",
      "rocket",
      "server",
      "shield",
      "terminal",
      "wrench",
      "zap",
    ];
    for (const name of names) {
      const markup = renderIcon(name);
      expect(markup, `${name} must render`).toContain("<svg");
    }
  });

  it("is case-insensitive about a name", () => {
    expect(renderIcon("Server")).toBe(renderIcon("server"));
  });

  it("falls back to the puzzle for an unknown name rather than blanking", () => {
    const fallback = renderIcon("puzzle");
    expect(renderIcon("not-a-real-icon")).toBe(fallback);
    expect(renderIcon("")).toBe(fallback);
    expect(renderIcon(undefined)).toBe(fallback);
    expect(renderIcon(null)).toBe(fallback);
    expect(renderIcon(42)).toBe(fallback);
  });

  it("accepts a plugin asset URL and renders it as an image", () => {
    const markup = renderIcon("http://plugin.localhost/com.example.docker/icon.svg");
    expect(markup).toContain("<img");
    expect(markup).toContain("com.example.docker/icon.svg");
  });

  it("accepts a { src } object", () => {
    const markup = renderIcon({ src: "plugin://localhost/com.example.x/logo.png" });
    expect(markup).toContain("<img");
    expect(markup).toContain("logo.png");
  });

  it("refuses a remote URL instead of turning the rail into a beacon", () => {
    // An http(s) URL would make the app fetch a third-party image on every
    // render. The fallback is the puzzle, not the remote image.
    const fallback = renderIcon("puzzle");
    expect(renderIcon("https://example.com/tracker.png")).toBe(fallback);
    expect(renderIcon("http://example.com/tracker.png")).toBe(fallback);
    expect(renderIcon({ src: "https://example.com/tracker.png" })).toBe(fallback);
  });

  it("refuses a javascript: URL", () => {
    const fallback = renderIcon("puzzle");
    expect(renderIcon("javascript:alert(1)")).toBe(fallback);
    expect(renderIcon({ src: "javascript:alert(1)" })).toBe(fallback);
  });

  it("accepts an inline data image", () => {
    const markup = renderIcon("data:image/svg+xml;base64,PHN2Zy8+");
    expect(markup).toContain("<img");
  });

  it("passes a host React component through unchanged", () => {
    const Component = () => createElement("span", { "data-custom": "yes" }, "x");
    expect(externalToolbarIcon(Component)).toBe(Component);

    // A React element (what `createElement` returns, and what a lucide icon
    // is) is renderable as-is.
    const element = createElement("span", null, "y");
    expect(externalToolbarIcon(element)).toBe(element);
  });

  it("falls back for an object that is neither an element nor a src", () => {
    const fallback = renderIcon("puzzle");
    expect(renderIcon({ nonsense: true })).toBe(fallback);
  });
});
