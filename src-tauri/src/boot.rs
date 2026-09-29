//! Startup choreography for the main window.
//!
//! `tauri.conf.json` declares the window `visible: false`. A native window has
//! nothing to draw until WebView2 has been created *and* has navigated to the
//! first page, so a window shown at creation time is a blank white rectangle
//! for that whole stretch — and no HTML, however early it paints, can cover
//! it, because the page does not exist yet.
//!
//! So the window stays hidden until the page reports in ([`boot_ready`]) that
//! its inline splash (`index.html`) has been painted. It is then shown already
//! filled with the themed splash instead of white. [`arm_reveal_deadline`]
//! guarantees the window still appears if the page never reports in (dev
//! server down, script error): a hidden window with no way to open it is the
//! worst possible failure mode for this trick.
//!
//! The same module keeps a boot timeline. Rust stamps native milestones and the
//! page forwards its own ([`boot_trace`]), so `tauri dev` prints one merged
//! list on a single clock — which is what makes "where does the wait go?"
//! answerable instead of guessable. Tracing is compiled out of release builds.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewWindow};

/// Label of the window declared in `tauri.conf.json` (Tauri's default).
const MAIN_WINDOW: &str = "main";

/// How long the window may stay hidden waiting for the page to report in.
///
/// Generous on purpose: the page reports as soon as the splash HTML paints,
/// which is well before any script has to run, so hitting this means
/// something is genuinely wrong rather than merely slow.
pub const REVEAL_DEADLINE: Duration = Duration::from_secs(8);

static CLOCK_START: OnceLock<Instant> = OnceLock::new();

/// One-shot latch: the first caller to [`RevealGate::claim`] wins.
///
/// Both the page (`boot_ready`) and the deadline timer try to show the window;
/// only one of them may, and a dev-server reload that re-runs the page's inline
/// script must not pop a window the user has since minimised.
pub struct RevealGate(AtomicBool);

impl RevealGate {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// True for exactly one caller until [`RevealGate::release`] is called.
    pub fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::AcqRel)
    }

    /// Re-opens the latch so a failed `show()` can be retried by the deadline.
    pub fn release(&self) {
        self.0.store(false, Ordering::Release);
    }
}

static REVEAL: RevealGate = RevealGate::new();

/// Starts the boot clock. Idempotent; call it first thing in `run()`.
pub fn start_clock() {
    CLOCK_START.get_or_init(Instant::now);
}

/// Milliseconds since [`start_clock`] (starting it if nobody has).
pub fn elapsed_ms() -> u128 {
    CLOCK_START.get_or_init(Instant::now).elapsed().as_millis()
}

/// Prints one boot-timeline line. Debug builds only.
pub fn trace(stage: &str) {
    if cfg!(debug_assertions) {
        eprintln!("[boot +{:>5}ms] {stage}", elapsed_ms());
    }
}

/// Parses `#rrggbb` / `rrggbb` into an opaque colour. `None` for anything else.
pub fn parse_hex_color(input: &str) -> Option<Color> {
    let hex = input.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    Some(Color(channel(0..2)?, channel(2..4)?, channel(4..6)?, 255))
}

/// Shows the main window, once.
///
/// `background` is the splash colour the page is currently painting. It is
/// applied to the window and webview first so that any frame WebView2 has not
/// produced yet — the moment right after `show()` — matches the splash
/// instead of flashing the default white.
pub fn reveal(window: &WebviewWindow, background: Option<&str>, reason: &str) {
    if !REVEAL.claim() {
        return;
    }
    if let Some(color) = background.and_then(parse_hex_color) {
        if let Err(error) = window.set_background_color(Some(color)) {
            trace(&format!("could not tint the window background: {error}"));
        }
    }
    trace(&format!("showing the window ({reason})"));
    if let Err(error) = window.show() {
        REVEAL.release();
        eprintln!("failed to show the main window: {error}");
    }
}

/// Backstop for [`reveal`]: shows the window after [`REVEAL_DEADLINE`] if the
/// page has not done so. A no-op when it already has.
pub fn arm_reveal_deadline(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_DEADLINE).await;
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            reveal(&window, None, "deadline reached before the page reported in");
        }
    });
}

/// Called by the inline script in `index.html` once the splash has painted.
///
/// `via` is free-form diagnostics from the page (which path fired, when its
/// script ran); it only feeds the boot timeline.
#[tauri::command]
pub fn boot_ready(
    window: WebviewWindow,
    page_ms: Option<u64>,
    background: Option<String>,
    via: Option<String>,
) {
    trace(&format!(
        "page   splash painted via {} (page +{}ms)",
        via.as_deref().unwrap_or("unknown"),
        page_ms.unwrap_or_default()
    ));
    reveal(&window, background.as_deref(), "splash painted");
}

/// Receives one milestone from the page so it lands on the same timeline as
/// the native ones. `page_ms` is the page's own `performance.now()`.
#[tauri::command]
pub fn boot_trace(stage: String, page_ms: u64) {
    trace(&format!("page   {stage} (page +{page_ms}ms)"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_lets_exactly_one_caller_through() {
        let gate = RevealGate::new();
        assert!(gate.claim());
        assert!(!gate.claim());
        assert!(!gate.claim());
    }

    #[test]
    fn gate_can_be_reopened_after_a_failed_show() {
        let gate = RevealGate::new();
        assert!(gate.claim());
        gate.release();
        assert!(gate.claim());
    }

    #[test]
    fn parses_the_splash_colours() {
        assert_eq!(parse_hex_color("#e8ecf2"), Some(Color(0xe8, 0xec, 0xf2, 255)));
        assert_eq!(parse_hex_color("0e1118"), Some(Color(0x0e, 0x11, 0x18, 255)));
        assert_eq!(parse_hex_color("  #0E1118 "), Some(Color(0x0e, 0x11, 0x18, 255)));
    }

    #[test]
    fn rejects_anything_that_is_not_six_hex_digits() {
        assert_eq!(parse_hex_color(""), None);
        assert_eq!(parse_hex_color("#fff"), None);
        assert_eq!(parse_hex_color("#e8ecf2ff"), None);
        assert_eq!(parse_hex_color("#gggggg"), None);
        assert_eq!(parse_hex_color("rgb(0, 0, 0)"), None);
        // Multi-byte input must not panic on a byte-index slice.
        assert_eq!(parse_hex_color("#ééé"), None);
    }
}
