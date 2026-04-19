# Server Status Guide

This document describes the current server status panel in eShell.

## 1. UX Behavior

The status panel is split into two levels:
- top summary keeps CPU, memory, and network visible at all times
- lower detail area switches between `Processes` and `Disks` to avoid a crowded stacked layout

Current display rules:
- CPU is shown as a percentage bar
- summary memory is shown as `used / total` in `GB`
- process memory is shown in `MB`
- disk rows show mount point, used / total, and a usage bar
- fetched time is rendered with the current UI locale

If status polling fails for one cycle because of a transient network issue, the UI shows a retry warning instead of treating it as a hard failure.

## 2. Backend Commands

- `fetch_server_status`
- `get_cached_server_status`

Request input:
- `sessionId`
- `selectedInterface` (optional)

## 3. Data Semantics

`ServerStatus` currently contains:
- `cpuPercent`
- `memory`
- `networkInterfaces`
- `selectedInterface`
- `selectedInterfaceTraffic`
- `topProcesses`
- `disks`
- `fetchedAt`

Important field semantics:
- `memory.usedMb` and `memory.totalMb` are returned in megabytes and rendered as `GB` in the summary UI
- `memory.usedPercent` is still available for progress-bar rendering
- `topProcesses[].memoryMb` is parsed from `ps` RSS output and converted from `KB` to `MB`
- `disks[].usedPercent` remains a string as parsed from `df -hP`

## 4. Process and Disk Views

`Processes` view:
- optimized for quick triage
- shows `PID`, `CPU %`, `Memory (MB)`, and command
- sorted from backend shell output by CPU usage

`Disks` view:
- optimized for mount-point readability
- surfaces usage as a simple card-style list instead of a dense table
- helps avoid line wrapping on long mount paths

## 5. Frontend Integration

Main frontend files:
- `src/components/panels/StatusPanel.jsx`
- `src/components/panels/status/StatusResourceBars.jsx`
- `src/components/panels/status/StatusTrafficPanel.jsx`
- `src/hooks/workbench/operations.js`

Backend parsing files:
- `src-tauri/src/server_ops/service.rs`
- `src-tauri/src/server_ops/status_parser.rs`
- `src-tauri/src/models.rs`

## 6. Troubleshooting Notes

- If network traffic appears empty, verify the selected NIC is correct for the remote host.
- If process memory looks unexpectedly small, remember it now reflects RSS in `MB`, not percent-of-system-memory.
- If the panel shows a warning banner but keeps updating afterward, that is the expected transient-retry path.
