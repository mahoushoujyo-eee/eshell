/**
 * Removes the startup splash painted by `index.html`.
 *
 * The splash is plain HTML so it covers the whole wait — module fetch and
 * parse included — rather than only the part after React boots. That means it
 * lives outside React and has to be torn down by hand.
 *
 * Call this after the first render commits, not before: rendering and layout
 * for a window this size are not free, and dropping the splash first would
 * expose the empty `#root` for exactly that stretch.
 */

/** Matches the `transition` on `#boot-splash` in `index.html`. */
const FADE_MS = 240;

export function dismissBootSplash() {
  if (typeof document === "undefined") {
    return;
  }
  const splash = document.getElementById("boot-splash");
  if (!splash) {
    return;
  }
  // Marked first so a second call (StrictMode's double effect, a hot reload)
  // is a no-op instead of stacking timers on a node that is already leaving.
  // `getAttribute`, not `dataset`: the attribute is what the CSS selector
  // matches, and the project's fake DOM implements attributes only.
  if (splash.getAttribute("data-leaving") === "true") {
    return;
  }
  splash.setAttribute("data-leaving", "true");

  let removed = false;
  const remove = () => {
    if (removed) {
      return;
    }
    removed = true;
    splash.remove();
  };

  splash.addEventListener("transitionend", remove, { once: true });
  // The timer is the guarantee, not a fallback: `transitionend` does not fire
  // when the element is already transparent (a background window, or a user
  // with reduced motion), and the splash must never outlive the app.
  window.setTimeout(remove, FADE_MS + 60);
}
