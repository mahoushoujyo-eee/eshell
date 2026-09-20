export const title = "Hello Plugin";

export function describeApi(version) {
  return `Loaded from an external ESM plugin through API v${version}.`;
}
