//! Server metrics: CPU, memory, network, disks, processes and GPUs.

use serde::{Deserialize, Serialize};

/// All-zero by default, which is what a host reports before the first poll
/// lands or when `top` output cannot be read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    pub used_mb: f64,
    pub total_mb: f64,
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceStatus {
    pub interface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub pid: i32,
    pub cpu_percent: f64,
    pub memory_mb: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStatus {
    pub filesystem: String,
    pub mount_point: String,
    pub used: String,
    pub total: String,
    pub used_percent: String,
}

/// One process holding memory on a GPU, from `nvidia-smi --query-compute-apps`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProcessStatus {
    pub pid: i32,
    pub memory_mb: Option<f64>,
    pub command: String,
}

/// One GPU, from `nvidia-smi --query-gpu`.
///
/// Every metric is optional: `nvidia-smi` reports `[N/A]` or `[Not Supported]`
/// for whatever the card or driver does not expose (power limits and fan speed
/// on datacenter and virtualised cards, most commonly).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub index: u32,
    pub name: String,
    pub utilization_percent: Option<f64>,
    pub memory_used_mb: Option<f64>,
    pub memory_total_mb: Option<f64>,
    pub temperature_c: Option<f64>,
    pub power_draw_w: Option<f64>,
    pub power_limit_w: Option<f64>,
    pub fan_percent: Option<f64>,
    pub processes: Vec<GpuProcessStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub cpu_percent: f64,
    pub memory: MemoryStatus,
    pub network_interfaces: Vec<NetworkInterfaceStatus>,
    pub selected_interface: Option<String>,
    pub selected_interface_traffic: Option<NetworkInterfaceStatus>,
    pub top_processes: Vec<ProcessStatus>,
    pub disks: Vec<DiskStatus>,
    /// Empty when the host has no NVIDIA GPU or no `nvidia-smi`.
    #[serde(default)]
    pub gpus: Vec<GpuStatus>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchServerStatusInput {
    pub session_id: String,
    pub selected_interface: Option<String>,
}
