#!/usr/bin/env bash
#
# Reproduce what a macOS user sees when they double-click our .dmg — and say why.
#
#   scripts/macos-gatekeeper-check.sh path/to/eshell_1.7.0_aarch64.dmg
#   scripts/macos-gatekeeper-check.sh --app /Applications/eshell.app
#
# Only runs on macOS (it drives hdiutil / codesign / spctl). Use the
# `macos-gatekeeper-check` job in .github/workflows/build-tauri.yml to run it on
# a GitHub macOS runner, which is how CI can catch this for a release artifact
# without anyone owning a Mac.
#
# ---------------------------------------------------------------------------
# Why this exists: "「eshell.dmg」已损坏，无法打开。你应该将它移到废纸篓。" is
# NOT about the file being corrupt. Gatekeeper prints that misleading wording
# when its *first-launch assessment* fails, and for an arm64 app that means one
# of the bundle / the disk image is not signed with a Developer ID and has no
# notarization ticket. The bytes are fine — which is exactly why extracting the
# dmg with a non-Apple tool (7-Zip, `tar`) produces a working app: unpacking
# drops the com.apple.quarantine attribute, and without that attribute Gatekeeper
# never runs the assessment. The same test runs here both ways to show it.
#
# Two further consequences worth knowing, both of which the script prints:
#   - The "damaged" wording is the hard-fail variant: right-click → Open and
#     Privacy & Security → "Open Anyway" do NOT clear it (that flow only covers
#     the softer "unidentified developer" alert), and spctl --master-disable
#     does not either. Only removing quarantine does.
#   - The in-app updater is unaffected: it fetches the .app.tar.gz with the app's
#     own HTTP client, so the new bundle never carries a quarantine flag. Users
#     already on a working install can keep updating normally.
#
# Exit codes: 0 = double-clickable for a downloading user (signed + notarized),
#             2 = not installable as shipped (currently: Gatekeeper refuses it,
#                 because our macOS bundles are unsigned),
#             1 = usage/environment error.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: macos-gatekeeper-check.sh <path.dmg>
       macos-gatekeeper-check.sh --app <path.app>
       macos-gatekeeper-check.sh <path.dmg> --allow-unsigned

  --allow-unsigned  always exit 0 when the artifact merely trips Gatekeeper
                    (used by CI so the check reports instead of failing a
                    release that has no signing secrets configured yet)
EOF
}

dmg=""
app=""
allow_unsigned=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --allow-unsigned) allow_unsigned=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
    *) dmg="$1"; shift ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This check needs macOS (hdiutil/codesign/spctl). Run it in the" >&2
  echo "macos-gatekeeper-check GitHub job instead." >&2
  exit 1
fi

if [ -z "$dmg" ] && [ -z "$app" ]; then
  usage >&2
  exit 1
fi
if [ -n "$dmg" ] && [ ! -f "$dmg" ]; then
  echo "no such file: $dmg" >&2
  exit 1
fi
if [ -n "$app" ] && [ ! -d "$app" ]; then
  echo "no such bundle: $app" >&2
  exit 1
fi

WARNED=0
mount_point=""
# Always present: the simulated-quarantine copy of the app lives here even in
# --app mode, and cleanup must never expand to a path outside it.
workdir="$(mktemp -d)"
cleanup() {
  if [ -n "$mount_point" ] && mount | grep -qF "on $mount_point "; then
    hdiutil detach "$mount_point" -quiet || true
  fi
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    rm -rf "$workdir"
  fi
}
trap cleanup EXIT

section() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------------------
# 1. Is the file itself intact? (Kills the "the download is corrupt" theory.)
# ---------------------------------------------------------------------------
if [ -n "$dmg" ]; then
  section "Disk image integrity"
  echo "file: $(ls -lh "$dmg" | awk '{print $5}')"
  shasum -a 256 "$dmg"
  if hdiutil verify "$dmg"; then
    echo "hdiutil verify: OK — the image is not corrupt"
  else
    echo "hdiutil verify: FAILED — this one really is a broken download"
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# 2. Assess the image the way a browser download arrives: with the quarantine
#    attribute Finder/Safari sets. This is the assessment the user's Mac runs.
# ---------------------------------------------------------------------------
if [ -n "$dmg" ]; then
  section "Gatekeeper assessment of the .dmg as downloaded"
  scored_dmg="$workdir/as-downloaded.dmg"
  cp "$dmg" "$scored_dmg"
  # 0081 = quarantine flag + "downloaded by a browser", the payload Safari/Chrome write.
  xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$scored_dmg"
  echo "quarantine: $(xattr -p com.apple.quarantine "$scored_dmg")"
  # -t open --context context:primary-signature is how macOS assesses a disk
  # image; a plain `spctl -a` on it answers a different question.
  if spctl -a -vvv -t open --context context:primary-signature "$scored_dmg"; then
    echo "verdict: the disk image passes"
  else
    echo "verdict: REJECTED — Finder would say 「已损坏，无法打开」"
    WARNED=1
  fi

  section "Mounting"
  mount_point="$workdir/mnt"
  mkdir -p "$mount_point"
  hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_point" -quiet
  # The bundle inside; taken from the mounted image, so it keeps whatever
  # attributes the build shipped (normally none).
  app="$(find "$mount_point" -maxdepth 1 -name '*.app' -print -quit)"
  if [ -z "$app" ]; then
    echo "no .app inside the image" >&2
    exit 1
  fi
  echo "app: $app"
fi

# ---------------------------------------------------------------------------
# 3. Signature of the bundle: Developer ID (good) vs ad-hoc (Gatekeeper rejects
#    a quarantined copy) vs absent (cannot even launch on arm64).
# ---------------------------------------------------------------------------
section "Code signature"
codesign -dv --verbose=4 "$app" 2>&1 || echo "-> not signed as a bundle (codesign found no signature)"
echo
codesign --verify --deep --strict --verbose=2 "$app" 2>&1 || WARNED=1
echo
if ! command -v xcrun >/dev/null 2>&1; then
  echo "-> skipped: xcrun is unavailable (no Command Line Tools)"
elif xcrun stapler validate "$app" 2>&1; then
  echo "-> notarization ticket stapled"
else
  echo "-> no notarization ticket (an unsigned/unnotarized build never has one)"
  WARNED=1
fi

section "Architecture"
executable="$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist" 2>/dev/null || true)"
if [ -n "$executable" ]; then
  command -v lipo >/dev/null 2>&1 && lipo -archs "$app/Contents/MacOS/$executable" || true
  echo "(arm64 requires at least an ad-hoc signature to launch at all; the"
  echo " linker adds one automatically, which is why a quarantine-stripped"
  echo " copy runs while the downloaded copy is refused)"
fi

# ---------------------------------------------------------------------------
# 4. The decisive experiment: same bytes, +/- quarantine, as the user's Mac sees
#    them. Stripped == what extracting the dmg by hand gives you.
# ---------------------------------------------------------------------------
section "First-launch assessment of the .app"
if spctl -a -vvv -t exec "$app"; then
  echo "verdict without quarantine: accepted"
  echo "(this is the state an unpacked copy is in — it will launch)"
else
  echo "verdict without quarantine: rejected by spctl (an unpacked copy still"
  echo "launches, because Finder only runs this check on a quarantined item)"
fi

echo
simulated="$workdir/App.app"
rm -rf "$simulated"
if ditto "$app" "$simulated" 2>/dev/null; then
  xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$simulated"
  if spctl -a -vvv -t exec "$simulated"; then
    echo "verdict WITH quarantine (what the downloading user gets): accepted"
  else
    echo "verdict WITH quarantine (what the downloading user gets): REJECTED"
    echo "-> Finder: 「eshell.app 已损坏，无法打开。你应该将它移到废纸篓。」"
    WARNED=1
  fi
fi

# ---------------------------------------------------------------------------
# 5. Verdict + what to do about it.
# ---------------------------------------------------------------------------
section "Verdict"
if [ "$WARNED" -eq 0 ]; then
  echo "Signed and notarized: a downloading user can double-click it."
  exit 0
fi

cat <<'EOF'
Gatekeeper will refuse this artifact on a Mac that downloaded it, and the
wording it uses ("已损坏") is misleading — the bytes are intact.

Users can work around it today (this is also the answer to give support):

    xattr -dr com.apple.quarantine ~/Downloads/eshell_*_aarch64.dmg   # before opening
    # or, after dragging the app to /Applications:
    sudo xattr -dr com.apple.quarantine /Applications/eshell.app

The real fix is to sign with a Developer ID and notarize. In
.github/workflows/build-tauri.yml that is the repository secrets below, after
which tauri itself signs the bundle and submits it for notarization:

    APPLE_CERTIFICATE            Developer ID Application cert (.p12, base64)
    APPLE_CERTIFICATE_PASSWORD   its password
    APPLE_SIGNING_IDENTITY       "Developer ID Application: ... (TEAMID)"
    APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   notarization credentials

Until then the check stays red on purpose: it is the only automated thing that
notices this, since nothing on Linux/Windows CI touches the signature.
EOF

if [ "$allow_unsigned" -eq 1 ]; then
  echo
  echo "--allow-unsigned set: reporting only, exiting 0."
  exit 0
fi
exit 2
