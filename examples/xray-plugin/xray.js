// The barrel: one import point for everything below.
//
// The panel, the tests and any other module that wants the plugin's logic
// import from here, so the internal file layout can change without touching
// the callers.

export * from "./cli/config.js";
export * from "./cli/detect.js";
export * from "./cli/shell.js";
export * from "./cli/subscription.js";
export * from "./cli/validate.js";
export * from "./client.js";
export * from "./controller/derive.js";
export * from "./controller/index.js";
export * from "./controller/overlays.js";
export * from "./controller/prefs.js";
export * from "./failures.js";
export * from "./parse/config.js";
export * from "./parse/observatory.js";
export * from "./parse/subscription.js";
export * from "./parse/uri.js";
