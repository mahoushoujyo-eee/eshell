// Value validation for the docker command builders.
//
// Ids and names come back from docker itself, but they still reach a command
// line. A value that does not match is refused rather than quoted: a malformed
// id means the parse went wrong, not that the plugin should guess. Values that
// legitimately contain spaces (paths, env values) are quoted instead — see
// `shellQuote` in `shell.js`.

import { assert, shellQuote } from "./shell.js";

/** A container/network id: hex, as docker prints it. */
const SAFE_ID = /^[0-9a-f]{6,64}$/i;
/** An image id: the same, with the optional `sha256:` prefix docker may add. */
const SAFE_IMAGE_ID = /^(sha256:)?[0-9a-f]{6,64}$/i;
/** A pull/tag reference: registry host, path, tag and digest, nothing else. */
const SAFE_IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
/** A container, volume, network or compose project name. */
const SAFE_OBJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** An environment variable name. */
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `docker kill --signal`. */
const SAFE_SIGNAL = /^(SIG)?[A-Z][A-Z0-9]{1,14}$/;
/** A `--since` / `--until` window: a Go duration or an RFC3339-ish stamp. */
const SAFE_WINDOW = /^(\d{1,9}(ns|us|ms|s|m|h)){1,4}$|^\d{4}-\d{2}-\d{2}([T ][\d:.+Z-]{1,20})?$/;
/** `--user`: name or uid, optionally `:group`. */
const SAFE_USER = /^[a-zA-Z0-9_.-]{1,64}(:[a-zA-Z0-9_.-]{1,64})?$/;
/** `-p`: `[ip:][hostPort[-range]:]containerPort[-range][/proto]`. */
const SAFE_PORT_SPEC =
  /^(?:(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):)?(?:\d{1,5}(?:-\d{1,5})?:)?\d{1,5}(?:-\d{1,5})?(?:\/(?:tcp|udp|sctp))?$/;
/** A restart policy, as `docker run --restart` accepts it. */
const SAFE_RESTART = /^(no|always|unless-stopped|on-failure(:\d{1,3})?)$/;
/** `--memory`: a byte count with an optional unit. */
const SAFE_BYTES = /^\d{1,12}([bkmgBKMG]|[kKmMgG][iI]?[bB])?$/;
/** `--cpus`. */
const SAFE_CPUS = /^\d{1,3}(\.\d{1,3})?$/;
/** A mount mode suffix (`ro`, `rw`, `z`, `ro,z`, …). */
const SAFE_MOUNT_MODE = /^[a-z]{1,10}(,[a-z]{1,10}){0,3}$/;
/** A network or volume driver name. */
const SAFE_DRIVER = /^[a-z][a-z0-9_.-]{0,31}$/;
/** A CIDR, for `docker network create --subnet`. */
const SAFE_CIDR = /^[0-9a-fA-F.:]{2,45}\/\d{1,3}$/;
/** An IP address, for `--gateway`. */
const SAFE_IP = /^[0-9a-fA-F.:]{2,45}$/;
/** A `--platform` value. */
const SAFE_PLATFORM = /^[a-z0-9]+\/[a-z0-9]+(\/v\d)?$/;
/** A Docker Hub search term. */
const SAFE_SEARCH_TERM = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

export const isSafeId = (id) => SAFE_ID.test(String(id ?? ""));
export const isSafeImageId = (id) => SAFE_IMAGE_ID.test(String(id ?? ""));
export const isSafeImageRef = (ref) => SAFE_IMAGE_REF.test(String(ref ?? ""));
export const isSafeObjectName = (name) => SAFE_OBJECT_NAME.test(String(name ?? ""));

/** A container reference: a docker id, or a container name. */
export function containerRef(value) {
  const text = String(value ?? "").trim();
  assert(
    isSafeId(text) || isSafeObjectName(text),
    "refusing to address a container by an unexpected reference",
  );
  return text;
}

/** An image reference or image id. */
export function imageRef(value) {
  const text = String(value ?? "").trim();
  assert(
    isSafeImageId(text) || isSafeImageRef(text),
    "refusing to address an image by an unexpected reference",
  );
  return text;
}

/** A reference that must be a pullable/taggable name, not an id. */
export function pullableRef(value) {
  const text = String(value ?? "").trim();
  assert(isSafeImageRef(text), "refusing to use an unexpected image reference");
  return text;
}

export function objectName(value, what) {
  const text = String(value ?? "").trim();
  assert(isSafeObjectName(text), `refusing to use an unexpected ${what} name`);
  return text;
}

const matching = (pattern, message) => (value) => {
  const text = String(value ?? "").trim();
  assert(pattern.test(text), message);
  return text;
};

export const signalName = (value) => {
  const text = String(value ?? "").trim().toUpperCase();
  assert(SAFE_SIGNAL.test(text), "refusing to send an unexpected signal");
  return text;
};

export const timeWindow = matching(SAFE_WINDOW, "refusing an unexpected --since/--until value");
export const userSpec = matching(SAFE_USER, "refusing an unexpected --user value");
export const restartPolicy = matching(SAFE_RESTART, "not a valid restart policy");
export const byteSize = matching(SAFE_BYTES, "not a valid --memory value");
export const cpuCount = matching(SAFE_CPUS, "not a valid --cpus value");
export const driverName = matching(SAFE_DRIVER, "not a valid driver name");
export const cidr = matching(SAFE_CIDR, "not a valid --subnet value");
export const ipAddress = matching(SAFE_IP, "not a valid --gateway value");
export const platform = matching(SAFE_PLATFORM, "not a valid --platform value");
export const searchTerm = matching(SAFE_SEARCH_TERM, "refusing to search for an unexpected term");

/** `KEY=value` for `-e` / `-l` / `--label`: key validated, value quoted. */
export function envAssignment(entry) {
  const text = String(entry ?? "");
  const separator = text.indexOf("=");
  assert(separator > 0, `expected KEY=value, got "${text}"`);
  const key = text.slice(0, separator);
  assert(SAFE_ENV_KEY.test(key), `not a valid environment variable name: "${key}"`);
  return `${key}=${shellQuote(text.slice(separator + 1))}`;
}

/** `-v source:target[:mode]`, each segment quoted on its own. */
export function bindSpec(entry) {
  const text = String(entry ?? "").trim();
  assert(text !== "", "an empty mount was given");
  const parts = text.split(":");
  assert(parts.length >= 2 && parts.length <= 3, `expected source:target[:mode], got "${text}"`);
  const [source, target, mode] = parts;
  assert(source !== "" && target !== "", `expected source:target[:mode], got "${text}"`);
  assert(target.startsWith("/"), "a mount target must be an absolute path");
  if (mode !== undefined) {
    assert(SAFE_MOUNT_MODE.test(mode), `not a valid mount mode: "${mode}"`);
  }
  // Adjacent quoted words concatenate in the shell, so docker still receives
  // one `source:target[:mode]` argument.
  const quoted = `${shellQuote(source)}:${shellQuote(target)}`;
  return mode === undefined ? quoted : `${quoted}:${mode}`;
}

export function portSpec(entry) {
  const text = String(entry ?? "").trim();
  assert(SAFE_PORT_SPEC.test(text), `not a valid port publish spec: "${text}"`);
  return text;
}

/** `--network`: a network name, or `container:<ref>`. */
export function networkTarget(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith("container:")) {
    return `container:${containerRef(text.slice("container:".length))}`;
  }
  return objectName(text, "network");
}
