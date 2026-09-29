// The file editor modal pulls in the markdown preview stack (react-markdown,
// remark, react-syntax-highlighter + Prism grammars) — none of which the first
// screen needs. It is loaded through this one function so that opening the
// editor and the idle preload share a single import (and a single chunk).
export const loadFileEditorModal = () => import("./FileEditorModal");

let preloaded = false;

/**
 * Warms the editor chunk once the app is up and idle, so the first file open
 * does not wait on the network/disk. Safe to call repeatedly; the second call
 * is a no-op. Returns a cancel function for the scheduled work.
 */
export function preloadFileEditorModal() {
  if (preloaded || typeof window === "undefined") {
    return () => {};
  }
  const run = () => {
    preloaded = true;
    // A failed preload only costs the head start: the real open retries.
    loadFileEditorModal().catch(() => {
      preloaded = false;
    });
  };
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(run, 1500);
  return () => window.clearTimeout(handle);
}
