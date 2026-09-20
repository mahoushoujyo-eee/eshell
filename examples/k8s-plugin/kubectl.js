// Public surface of the kubectl layer.
//
// The implementation lives in small focused modules; this barrel is the single
// import point for the controller, the panel and the test suite.
//
//   cli/shell.js       prefix handling, quoting, tokenising, heredoc
//   cli/validate.js    the charsets every value must match
//   cli/get.js         read-only commands
//   cli/workloads.js   scale / rollout / delete / node maintenance
//   cli/session.js     logs / exec / apply / port-forward
//   parse/table.js     the `-o wide` table reader
//   parse/status.js    what a cell's text means
//   failures.js        classification and wording
//   client.js          the async data layer the controller drives
//   kinds.js           the resource types the panel offers, and their verbs

export { DEFAULT_BIN, sanitizeBin, shellQuote, tokenizeArgs } from "./cli/shell.js";

export {
  isSafeKind,
  isSafeName,
  isSafeNamespace,
  namespaceFlags,
  resourceName,
} from "./cli/validate.js";

export {
  apiResourcesCommand,
  clusterInfoCommand,
  contextsCommand,
  currentContextCommand,
  describeCommand,
  eventsCommand,
  explainCommand,
  getCommand,
  namespacesCommand,
  podContainersCommand,
  topCommand,
  versionCommand,
  yamlCommand,
} from "./cli/get.js";

export {
  cordonCommand,
  deleteCommand,
  drainCommand,
  rolloutCommand,
  scaleCommand,
  suspendCommand,
  triggerCronJobCommand,
  uncordonCommand,
} from "./cli/workloads.js";

export {
  applyCommand,
  applyFileCommand,
  execCommand,
  logsCommand,
  portForwardCommand,
  workloadLogsCommand,
} from "./cli/session.js";

export { parseContainers, parseContexts, parseNameList, parseTable, parseVersion } from "./parse/table.js";

export {
  cellTone,
  displayCell,
  isNoisyColumn,
  readyFraction,
  restartCount,
  rowTone,
} from "./parse/status.js";

export { classifyFailure, describeFailure, emptyListMessage } from "./failures.js";

export { createKubectlClient } from "./client.js";

export { ACTIONS, KINDS, KIND_BY_KEY, resolveKind, supports } from "./kinds.js";
