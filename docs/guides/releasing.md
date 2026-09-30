# Releasing Guide

`.github/workflows/build-tauri.yml` builds Windows (NSIS + MSI), macOS (arm64
dmg + updater tarball) and Linux (AppImage + deb + rpm) bundles on a tag push
(`v*`) or a manual run, and the `release` job publishes them with the notes in
`docs/releases/<tag>.md` (a tag without that file fails the job, on purpose).

Two signing systems are involved and they are easy to confuse:

| Secret | Signs | Not |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` (+ password) | the in-app **updater** artifacts (`.sig` next to each installer) | Apple code signing |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | the macOS bundle: Developer ID signature + notarization | Windows/Linux, or the updater |

The build step unsets any of these that are empty, so a repo without Apple
credentials builds exactly as it did before.

## macOS: why downloads say "已损坏" (and why that is not damage)

Without the `APPLE_*` secrets the macOS bundle is **unsigned**: the only
signature it carries is the ad-hoc one the linker adds to arm64 binaries. A
quarantined copy (i.e. anything a browser downloaded) fails Gatekeeper's
first-launch assessment, and the alert it shows is the misleading
"「eshell.dmg」已损坏，无法打开。你应该将它移到废纸篓。" — never a corruption
report, despite the wording.

Verified on the v1.7.0 release artifacts:

- `7z t eshell_1.7.0_aarch64.dmg` → "Everything is Ok"; the image is intact.
- The bundle inside holds only `Contents/Info.plist`, `Contents/MacOS/eshell`,
  `Contents/Resources/icon.icns` — **no `Contents/_CodeSignature`**, so it was
  never signed as a bundle (and therefore cannot have a notarization ticket).
- `Contents/MacOS/eshell` carries one `LC_CODE_SIGNATURE` blob whose
  `CodeDirectory` has `CS_ADHOC` set and the linker-style identifier
  `eshell-35a9c68a1ab3c4de`: the ad-hoc linker signature, no Developer ID.

That combination also explains the two behaviours users report:

- **Unpacking by hand works.** Extracting the dmg with anything other than
  Finder (7-Zip, `tar`, `hdiutil attach`) drops `com.apple.quarantine`, and the
  ad-hoc signature is enough for the arm64 loader. Same bytes, no assessment.
- **Bypassing the block does not work.** "已损坏" is Gatekeeper's hard-fail
  wording; right-click → Open, Privacy & Security → "Open Anyway" and
  `spctl --master-disable` all cover the softer "unidentified developer" alert
  only. What actually clears it is deleting the quarantine attribute — on the
  **dmg** (before opening) or on the installed app:

  ```bash
  xattr -dr com.apple.quarantine ~/Downloads/eshell_*_aarch64.dmg
  sudo xattr -dr com.apple.quarantine /Applications/eshell.app
  ```

  Existing installs are unaffected by all of this: the updater downloads
  `eshell.app.tar.gz` with the app's own HTTP client, so the replacement bundle
  never gets a quarantine flag.

The durable fix is a Developer ID Application certificate and notarization (paid
Apple Developer account). Tauri does both itself once the secrets above exist;
signing without notarizing still fails the first launch, so both are needed.

## Checking a build the way a user's Mac sees it

Nothing on the Windows or Linux runners can observe any of the above, so the
`gatekeeper-check` job runs on `macos-latest` and drives
[`scripts/macos-gatekeeper-check.sh`](../../scripts/macos-gatekeeper-check.sh):

```bash
# freshly built bundle (the job's default)
scripts/macos-gatekeeper-check.sh src-tauri/target/release/bundle/dmg/eshell_1.7.0_aarch64.dmg

# an already released artifact, to reproduce a user's report without a Mac:
#   Actions → build-tauri → Run workflow → dmg_url = <release asset URL>
```

The script verifies the image (`hdiutil verify`), scores the image and the app
with `spctl` **both with and without** a synthesized `com.apple.quarantine`
attribute, and dumps `codesign -dv`, `codesign --verify --deep --strict`,
`stapler validate` and the binary's architectures. It exits `2` when a
downloading user would be refused and `1` on usage/environment errors; the CI
job passes `--allow-unsigned` so it reports today's known-unsigned state instead
of failing every tag — a genuinely corrupt image still fails the job. Once the
Apple secrets are configured the check should be made a hard failure, and its
verdict is worth keeping in the release checklist.

Two things about running this on a runner rather than a laptop:

- **The job log body is not readable without a token** (the Actions API wants
  auth for `/logs`, and the HTML no longer inlines it). So the step captures the
  output and re-emits the tail as an `::error::` annotation on failure, which
  *is* readable through the public check-runs API. Keep that when editing.
- **A failing command in an `EXIT` trap becomes the script's exit status under
  `set -e`.** The first version of this gated its `hdiutil detach` on `mount`
  output containing the mount point; on macOS `mount` prints the resolved path
  (`/private/var/folders/...` for the `/var/folders/...` that `mktemp -d`
  returns), so the detach was skipped, `rm -rf` failed on the still-mounted
  directory, and a run that had assessed everything correctly exited `1`. The
  cleanup now detaches unconditionally, disables `set -e` *and* drops the ERR
  trap, because the trap's exit status is the run's verdict.
