export function formatBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const display = value / 1024 ** index;
  return `${display.toFixed(display >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
