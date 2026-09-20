// Image commands: listing, pull/push, tag, history, removal, Hub search.

import { JSON_FORMAT, cli, positiveInt, when } from "./shell.js";
import { imageRef, platform, pullableRef, searchTerm } from "./validate.js";

export const imagesCommand = (listOptions = {}, options = {}) =>
  cli(
    options,
    "images",
    "--no-trunc",
    "--digests",
    when(listOptions.all, "-a"),
    when(listOptions.dangling, "--filter", "dangling=true"),
    JSON_FORMAT,
  );

export const imageHistoryCommand = (reference, options = {}) =>
  cli(options, "image", "history", "--no-trunc", JSON_FORMAT, imageRef(reference));

export const imageInspectCommand = (reference, options = {}) =>
  cli(options, "image", "inspect", imageRef(reference));

export const pullCommand = (reference, pullOptions = {}, options = {}) =>
  cli(
    options,
    "pull",
    when(pullOptions.allTags, "-a"),
    pullOptions.platform ? `--platform=${platform(pullOptions.platform)}` : "",
    pullableRef(reference),
  );

export const pushCommand = (reference, options = {}) =>
  cli(options, "push", pullableRef(reference));

export const tagCommand = (source, target, options = {}) =>
  cli(options, "tag", imageRef(source), pullableRef(target));

export const removeImageCommand = (reference, removeOptions = {}, options = {}) =>
  cli(
    options,
    "rmi",
    when(removeOptions.force, "-f"),
    when(removeOptions.noPrune, "--no-prune"),
    imageRef(reference),
  );

export const pruneImagesCommand = (pruneOptions = {}, options = {}) =>
  cli(options, "image", "prune", "-f", when(pruneOptions.all, "-a"));

export const searchCommand = (term, searchOptions = {}, options = {}) =>
  cli(
    options,
    "search",
    `--limit ${positiveInt(searchOptions.limit, 25)}`,
    JSON_FORMAT,
    searchTerm(term),
  );
