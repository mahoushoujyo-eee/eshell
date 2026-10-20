/**
 * The desktop platform as the UI needs it. Tauri's webviews report the host
 * through the usual navigator fields, so no IPC is involved.
 */
export function detectDesktopPlatform() {
  if (typeof window === "undefined") {
    return "unknown";
  }

  const source =
    window.navigator?.userAgentData?.platform ||
    window.navigator?.platform ||
    window.navigator?.userAgent ||
    "";
  const normalized = String(source).toLowerCase();

  if (normalized.includes("mac")) {
    return "macos";
  }
  if (normalized.includes("win")) {
    return "windows";
  }
  if (normalized.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

/**
 * Mirrors the attribute `index.html` writes, once the module graph is up.
 * The CSS keys off it to round the shell only where the window is
 * transparent.
 */
export function applyDesktopPlatformAttribute() {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-desktop-platform", detectDesktopPlatform());
}
