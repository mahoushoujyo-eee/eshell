# Unreleased Changes

Last updated: 2026-09-20

## Example Plugins

- **New `examples/k8s-plugin/`** — a kubectl client for the active SSH session's
  host. Any resource type in any namespace or context (tabs for the common ones,
  a box for CRDs), listings rendered from `kubectl get -o wide`, status colouring
  read from the cells themselves, logs with a container picker, non-interactive
  `exec`, describe / `-o yaml` / events / explain, scale, rollout restart /
  status / history / undo, CronJob suspend and manual runs, node cordon /
  uncordon / drain, `kubectl top`, bulk delete, and `kubectl apply -f -` with a
  server-side dry run.
- **`examples/docker-plugin/` grew into a full Docker client** — volumes,
  networks, Compose projects, `docker events`, a System tab over `docker info` /
  `docker version` / `docker system df` with every prune variant, a `docker run`
  form with a live command preview, non-interactive `exec`, bulk container
  actions, live `docker stats`, and Docker Hub search. Listings now read
  `--format '{{json .}}'` instead of tab templates.
- Both plugins follow the app's language (English / 简体中文) by observing
  `<html lang>`, ship their own icon, and keep every destructive action behind a
  confirmation that shows the exact command it will run.

Nothing else yet. Everything through 1.6.0 shipped in [v1.6.0](v1.6.0.md).

## How To Use This File

Record notable user-facing changes on the current branch here as they land, then
move them into `v<next>.md` when cutting a release. The release workflow reads
`docs/releases/<tag>.md` for the GitHub release body, so a tag without that file
fails the build.
