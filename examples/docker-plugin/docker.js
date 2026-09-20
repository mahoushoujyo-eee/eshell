// Public surface of the docker layer.
//
// The implementation lives in small focused modules; this barrel is the single
// import point for the controller, the panel and the test suite, so those never
// have to know which file a builder happens to live in.
//
//   cli/shell.js        prefix handling, quoting, tokenising
//   cli/validate.js     the charsets every value must match
//   cli/*.js            one file per docker object family
//   parse/lists.js      `--format '{{json .}}'` rows
//   parse/objects.js    inspect / info / version
//   failures.js         classification and wording
//   client.js           the async data layer the controller drives

export {
  DEFAULT_BIN,
  JSON_FORMAT,
  quoteCommandLine,
  sanitizeBin,
  shellQuote,
  tokenizeArgs,
} from "./cli/shell.js";

export {
  containerRef,
  imageRef,
  isSafeId,
  isSafeImageId,
  isSafeImageRef,
  isSafeObjectName,
} from "./cli/validate.js";

export {
  containerActionCommand,
  containerDiffCommand,
  containerExecCommand,
  containerInspectCommand,
  containerLogsCommand,
  containerPortCommand,
  containerPruneCommand,
  containerRenameCommand,
  containerStatsCommand,
  containerTopCommand,
  containersCommand,
  runCommand,
} from "./cli/containers.js";

export {
  imageHistoryCommand,
  imageInspectCommand,
  imagesCommand,
  pruneImagesCommand,
  pullCommand,
  pushCommand,
  removeImageCommand,
  searchCommand,
  tagCommand,
} from "./cli/images.js";

export {
  networkConnectCommand,
  networkCreateCommand,
  networkDisconnectCommand,
  networkInspectCommand,
  networkPruneCommand,
  networkRemoveCommand,
  networksCommand,
  volumeCreateCommand,
  volumeInspectCommand,
  volumePruneCommand,
  volumeRemoveCommand,
  volumesCommand,
} from "./cli/objects.js";

export {
  composeActionCommand,
  composeLogsCommand,
  composeProjectsCommand,
} from "./cli/compose.js";

export {
  builderPruneCommand,
  eventsCommand,
  infoCommand,
  systemDfCommand,
  systemDfVerboseCommand,
  systemPruneCommand,
  versionCommand,
} from "./cli/system.js";

export {
  deriveState,
  parseComposeProjects,
  parseContainers,
  parseEvents,
  parseImageHistory,
  parseImages,
  parseJsonRows,
  parseLabels,
  parseNetworks,
  parseSearch,
  parseStats,
  parseSystemDf,
  parseVolumes,
} from "./parse/lists.js";

export { parseInfo, parseInspect, parseInspectEntry, parseVersion } from "./parse/objects.js";

export { classifyDockerFailure, describeDockerFailure } from "./failures.js";

export { createDockerClient } from "./client.js";
