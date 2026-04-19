# SFTP Transfer Guide

This document describes the SFTP upload/download behavior in eShell.

## 1. UX Behavior

From the SFTP panel:
- `Path`: set local download directory
- `Upload`: upload selected local file to current remote directory
- `Download`: download selected remote file to configured local directory
- `Transfers`: open collapsible transfer overlay
- the split layout keeps the left tree narrower so the right-side remote entry list has more working room
- context menus, confirms, and toolbar labels follow the active app locale (`English` / `简体中文`)

Transfer overlay includes:
- direction (`Upload`/`Download`)
- file name
- stage (`Queued`, `Transferring`, `Completed`, `Failed`, `Cancelled`)
- progress bar and bytes
- local path
- `Cancel` button for active tasks

## 2. Backend Commands

- `sftp_upload_file_with_progress`
- `sftp_download_file_to_local`
- `sftp_default_download_dir`
- `sftp_cancel_transfer`

Legacy commands still exist:
- `sftp_upload_file` (base64 payload)
- `sftp_download_file` (returns base64 payload)

## 3. Event Channel

Event name:
- `sftp-transfer`

Payload shape (camelCase):
- `transferId`
- `sessionId`
- `direction`
- `stage`
- `remotePath`
- `localPath`
- `fileName`
- `transferredBytes`
- `totalBytes`
- `percent`
- `message`

Stage values:
- `started`
- `progress`
- `completed`
- `failed`
- `cancelled`

Frontend normalizer/reducer:
- `src/lib/sftp-transfer.js`

## 4. Cancellation Semantics

- User clicks `Cancel` in transfer overlay.
- Frontend invokes `sftp_cancel_transfer` with `transferId`.
- Backend checks cancellation flag between transfer chunks.
- Transfer exits with `cancelled` event.
- Partial artifacts are best-effort cleaned:
  - download: local partial file removed
  - upload: remote partial file unlink attempted

## 5. Notes

- Current implementation is single-transfer-task based (no persisted resume queue).
- `cancelled` is treated as a user action, not a normal failure.
