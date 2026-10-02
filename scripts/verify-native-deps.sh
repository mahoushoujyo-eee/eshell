#!/usr/bin/env bash
#
# Fails loudly when a platform-scoped optional dependency did not get installed.
#
# npm silently skips them — npm/cli#4828, still open as of 2026 — and every
# package checked here is a native binary. Without `@tauri-apps/cli-<platform>`
# the Tauri CLI cannot even be `require`d, so `tauri build` dies in the same
# second it starts and the only output is "Cannot find native binding". That
# names the bug but not which package was dropped, and the job log needs a token
# to read, so the failure is expensive to diagnose from CI alone.
#
# `npm ci --include=optional` is the actual mitigation; this is what makes the
# *next* occurrence legible, and it moves the failure to the step that can name
# the package instead of a crash ten steps later.
#
# Deliberately portable bash: macOS runners ship bash 3.2, where `set -u` plus
# an empty array expansion is a fatal error, so no arrays are used.

set -eu

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=win32 ;;
  *)
    echo "::error::unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) cpu=x64 ;;
  aarch64 | arm64) cpu=arm64 ;;
  i386 | i686) cpu=ia32 ;;
  *)
    echo "::error::unsupported arch: $(uname -m)"
    exit 1
    ;;
esac

# glibc and musl ship different binaries, and picking the wrong one surfaces as
# the same "Cannot find native binding" at load time rather than at install time.
libc=gnu
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  libc=musl
fi

case "$os-$cpu" in
  win32-ia32) suffix=win32-ia32-msvc ;;
  win32-arm64) suffix=win32-arm64-msvc ;;
  win32-x64) suffix=win32-x64-msvc ;;
  darwin-x64) suffix=darwin-x64 ;;
  darwin-arm64) suffix=darwin-arm64 ;;
  *) suffix="$os-$cpu-$libc" ;;
esac

echo "platform: $suffix"

# esbuild drops the libc suffix entirely, so it is named separately.
missing=""
for pkg in \
  "@tauri-apps/cli-$suffix" \
  "@rollup/rollup-$suffix" \
  "@tailwindcss/oxide-$suffix" \
  "lightningcss-$suffix" \
  "@esbuild/$os-$cpu"
do
  if [ ! -d "node_modules/$pkg" ]; then
    missing="$missing $pkg"
  fi
done

if [ -n "$missing" ]; then
  echo "::error title=Native packages missing::npm did not install:$missing"
  echo "::error::This is npm/cli#4828 — npm silently skips platform-scoped"
  echo "::error::optional dependencies. The lockfile is fine; the install is not."
  exit 1
fi

echo "all native packages present for $suffix"
