/**
 * Stages the standalone `eshell-cli` and `eshell-mcp` binaries for bundling.
 *
 * The Windows installer ships them inside the app directory and offers to put
 * them on PATH, which means Tauri has to see them as `bundle.resources` — and
 * Tauri's build script validates resource paths **at compile time**, so this
 * cannot live in `beforeBundleCommand`. It runs from `beforeDevCommand` and
 * `beforeBuildCommand` instead: before cargo starts, in both profiles.
 *
 * `--debug` stages the debug binaries (`tauri dev` needs the files to exist but
 * never bundles them); the default stages release ones.
 *
 * The copies land in `src-tauri/binaries/`, which is git-ignored. A stamp check
 * keeps repeat runs to a few milliseconds: a stale copy would silently ship, so
 * the skip only applies when the staged files are newer than the crate's
 * sources.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(repoRoot, "src-tauri");
const stageDir = join(crateDir, "binaries");
const debug = process.argv.includes("--debug");
const profile = debug ? "debug" : "release";
const suffix = process.platform === "win32" ? ".exe" : "";
const names = ["eshell-cli", "eshell-mcp"];

// Only the Windows bundle references these as resources (the NSIS installer
// offers to put them on PATH). Linux and macOS ship them as release archives
// instead, built directly by the workflow, so bundling here would be dead
// weight on every local build.
if (process.platform !== "win32") {
  console.log("[stage-cli-tools] skipped: only the Windows bundle bundles them");
  process.exit(0);
}

const stagedPath = (name) => join(stageDir, `${name}${suffix}`);
// Dev and release stage to the same two files, so the profile has to be part of
// the freshness check: a `tauri dev` that left debug binaries behind must not
// let a later `tauri build` bundle them.
const stampPath = join(stageDir, ".stage-profile");

/** Newest mtime under `dir`, or 0 when it does not exist. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path));
    } else {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

function isFresh() {
  let newest = 0;
  try {
    newest = newestMtime(join(crateDir, "src"));
    newest = Math.max(newest, statSync(join(crateDir, "Cargo.toml")).mtimeMs);
  } catch {
    return false;
  }
  return names.every((name) => {
    try {
      const stats = statSync(stagedPath(name));
      // An empty file is a placeholder, never a staged binary.
      return stats.size > 0 && stats.mtimeMs >= newest;
    } catch {
      return false;
    }
  });
}

if (isFresh() && existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === profile) {
  console.log(`[stage-cli-tools] up to date (${profile})`);
  process.exit(0);
}

// Chicken and egg: `tauri-build` validates `bundle.resources` while compiling
// this crate, and the binaries it validates are the ones this script builds with
// cargo — so the build refuses to start until they exist. Empty placeholders
// satisfy the existence check; they are overwritten with real binaries below,
// and the size check at the end turns a failed copy into a build failure instead
// of an installer containing empty executables.
mkdirSync(stageDir, { recursive: true });
for (const name of names) {
  if (!existsSync(stagedPath(name))) {
    writeFileSync(stagedPath(name), "");
  }
}

console.log(`[stage-cli-tools] building ${names.join(", ")} (${profile})`);
const args = ["build", ...(debug ? [] : ["--release"])];
for (const name of names) {
  args.push("--bin", name);
}
execFileSync("cargo", args, {
  cwd: crateDir,
  stdio: "inherit",
});

for (const name of names) {
  const from = join(crateDir, "target", profile, `${name}${suffix}`);
  const to = stagedPath(name);
  copyFileSync(from, to);
  if (statSync(to).size === 0) {
    throw new Error(`[stage-cli-tools] ${to} is empty; refusing to bundle it`);
  }
  console.log(`[stage-cli-tools] ${from} -> ${to}`);
}
writeFileSync(stampPath, `${profile}\n`);
