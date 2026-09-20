// Thin re-export: the SFTP panel implementation now lives in the sftp plugin
// (src/plugins/sftp). This path stays so existing imports (including the UI
// baseline tests) keep working unchanged.
export { default } from "../../plugins/sftp/SftpPanel";
