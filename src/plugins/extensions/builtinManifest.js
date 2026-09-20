// The single builtin manifest (`extensions/builtin.json`) is the shared
// contract between the frontend, the Rust backend and the docs. It is bundled
// at build time so the frontend has a deterministic fallback for plain
// browsers (no Tauri backend) instead of guessing panel order.
import builtinManifestJson from "../../../extensions/builtin.json";

export const DEFAULT_BUILTIN_EXTENSION_MANIFEST = builtinManifestJson;

export default builtinManifestJson;
