# Docs Overview

`docs/` is organized by document purpose so prompts, specs, guides, and working notes stay separate.

## Structure

- `assets/`: documentation images and static assets
- `debug/`: temporary debug output captured during investigation
- `guides/`: development and feature behavior guides
- `guides/features/`: feature-specific guides such as Ops Agent, server status, and SFTP transfer
- `prompts/`: prompts used to generate or evolve the project
- `reports/`: remediation checklists, TODOs, and other progress records
- `releases/`: release notes
- `scratch/`: temporary drafts, samples, or ad hoc notes
- `specs/`: project-level specifications and API contracts
- `refer_proj/`: local reference projects and reverse-engineering material

## Placement Rules

- New project-generation or refactor prompts go in `prompts/`.
- Stable behavior or developer documentation goes in `guides/`.
- API contracts and scope definitions go in `specs/`.
- Temporary notes, checklists, and one-off records go in `reports/` or `scratch/`.
- Large external references stay under `refer_proj/`.
