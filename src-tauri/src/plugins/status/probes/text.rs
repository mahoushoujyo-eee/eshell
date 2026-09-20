//! Helpers shared by more than one probe when reading command output.

/// Rounds to two decimals. Metrics are read off human-oriented command output,
/// so more precision than the source has is noise.
pub(super) fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
