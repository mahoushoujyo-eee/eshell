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
- `topProcesses[].memoryMb` is the resident set (`RES`/`RSS`) converted from `KB` to `MB`, falling back to virtual size (`VSZ`) on busybox hosts, which report no resident size
- `topProcesses[].cpuPercent` is an instantaneous sample, not a lifetime average: the backend runs two `top` frames half a second apart and reads only the second one
- `disks[].usedPercent` remains a string as parsed from `df -hP`

## 4. Process and Disk Views

`Processes` view:
- optimized for quick triage
- shows `PID`, `CPU %`, `Memory (MB)`, and command
- capped at the five busiest processes, sorted by CPU usage
- the `top` / `ps` processes the poll itself starts are dropped: they live only as long as the sample, so they always report near-100% CPU

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
- `src-tauri/src/server_ops/status/` (one module per metric)
- `src-tauri/src/models/status.rs`

## 6. Troubleshooting Notes

- If network traffic appears empty, verify the selected NIC is correct for the remote host.
- If process memory looks unexpectedly small, remember it now reflects RSS in `MB`, not percent-of-system-memory.
- If the process list is empty, the host's `top` is probably rejecting the sampling command. Run `top -b -n2 -d0.5 -w512` there: busybox accepts neither `-w` nor a fractional `-d`, which is why the backend retries with plain `top -b -n2 -d1`.
- If the panel shows a warning banner but keeps updating afterward, that is the expected transient-retry path.
