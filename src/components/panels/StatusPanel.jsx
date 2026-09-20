// Thin re-export: the status panel implementation now lives in the
// server-monitor plugin (src/plugins/status). This path stays so existing
// imports (including the UI baseline tests) keep working unchanged.
export { default } from "../../plugins/status/StatusPanel";
