use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LocalDocument {
    Bootstrap,
    Recovery,
}

#[derive(Clone, Copy)]
pub(super) struct FrameHandoff {
    document: LocalDocument,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum FrameDelivery {
    Ignored,
    Failed,
    Ready(bool),
}

impl FrameHandoff {
    pub(super) fn bootstrap() -> Self {
        Self {
            document: LocalDocument::Bootstrap,
        }
    }

    pub(super) fn continuation_allowed(
        self,
        startup: &StartupRendezvous,
        current: Option<LocalDocument>,
    ) -> bool {
        current == Some(self.document)
            && !(self.document == LocalDocument::Bootstrap
                && startup.abandoned.load(Ordering::Acquire))
    }

    pub(super) fn deliver(
        self,
        startup: &StartupRendezvous,
        current: Option<LocalDocument>,
        native: impl FnOnce() -> bool,
    ) -> FrameDelivery {
        if !self.continuation_allowed(startup, current)
            || (self.document == LocalDocument::Bootstrap
                && startup.frame_ready.load(Ordering::Acquire))
        {
            return FrameDelivery::Ignored;
        }
        if !native() {
            return FrameDelivery::Failed;
        }
        FrameDelivery::Ready(
            self.document == LocalDocument::Bootstrap && startup.signal_frame_ready(),
        )
    }
}

#[cfg(mobile)]
pub(super) fn document_code(code: i32) -> Option<LocalDocument> {
    match code {
        1 => Some(LocalDocument::Bootstrap),
        2 => Some(LocalDocument::Recovery),
        _ => None,
    }
}

pub(super) fn local_document(url: &Url) -> Option<LocalDocument> {
    if !navigation_allowed(url, false) {
        return None;
    }
    if is_bootstrap_url(url) {
        Some(LocalDocument::Bootstrap)
    } else if is_recovery_url(url) && url.path() == RECOVERY_PATH {
        Some(LocalDocument::Recovery)
    } else {
        None
    }
}

pub(super) fn consume_local_frame(
    startup: &StartupRendezvous,
    document: LocalDocument,
    schedule: impl FnOnce(FrameHandoff),
) -> bool {
    if document == LocalDocument::Bootstrap
        && (startup.abandoned.load(Ordering::Acquire)
            || startup.frame_ready.load(Ordering::Acquire))
    {
        return false;
    }
    if document == LocalDocument::Recovery {
        startup.abandon();
    }
    schedule(FrameHandoff { document });
    true
}

static FOREGROUND: std::sync::OnceLock<std::sync::Mutex<ForegroundClock>> =
    std::sync::OnceLock::new();
const WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) fn set_foreground(foreground: bool) {
    foreground_clock().set_foreground(std::time::Instant::now(), foreground);
}

fn foreground_clock() -> std::sync::MutexGuard<'static, ForegroundClock> {
    FOREGROUND
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Default)]
struct ForegroundClock {
    elapsed: std::time::Duration,
    active_since: Option<std::time::Instant>,
}

impl ForegroundClock {
    fn set_foreground(&mut self, now: std::time::Instant, foreground: bool) {
        match (self.active_since, foreground) {
            (Some(start), false) => {
                self.elapsed = self
                    .elapsed
                    .saturating_add(now.saturating_duration_since(start));
                self.active_since = None;
            }
            (None, true) => self.active_since = Some(now),
            _ => {}
        }
    }

    fn elapsed(&self, now: std::time::Instant) -> std::time::Duration {
        self.elapsed.saturating_add(
            self.active_since
                .map(|start| now.saturating_duration_since(start))
                .unwrap_or_default(),
        )
    }
}

#[derive(Default)]
struct FrameWaitBudget {
    waiting_since: Option<std::time::Duration>,
}

impl FrameWaitBudget {
    fn tick(&mut self, foreground_elapsed: std::time::Duration, waiting: bool) -> bool {
        if !waiting {
            self.waiting_since = None;
            return false;
        }
        let start = *self.waiting_since.get_or_insert(foreground_elapsed);
        foreground_elapsed.saturating_sub(start) >= WAIT_LIMIT
    }
}

pub(crate) fn watch_bootstrap(window: &tauri::WebviewWindow) {
    let pending = window.clone();
    let spawned = std::thread::Builder::new()
        .name("alook-bootstrap-watch".into())
        .spawn(move || {
            let mut budget = FrameWaitBudget::default();
            loop {
                if STARTUP.abandoned.load(Ordering::Acquire)
                    || STARTUP.frame_ready.load(Ordering::Acquire)
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
                let now = std::time::Instant::now();
                let waiting = STARTUP.hooks_ready.load(Ordering::Acquire)
                    && STARTUP.bootstrap_finished.load(Ordering::Acquire);
                if budget.tick(foreground_clock().elapsed(now), waiting) {
                    let failed = pending.clone();
                    let _ = pending.run_on_main_thread(move || {
                        if STARTUP.frame_ready.load(Ordering::Acquire)
                            || STARTUP.abandoned.load(Ordering::Acquire)
                        {
                            return;
                        }
                        if !failed.url().is_ok_and(|url| is_bootstrap_url(&url)) {
                            return;
                        }
                        initialization_failure(&failed);
                        show_failure(&failed);
                    });
                    break;
                }
            }
        });
    if spawned.is_err() {
        initialization_failure(window);
        show_failure(window);
    }
}

pub(super) fn show_failure(window: &tauri::WebviewWindow) {
    #[cfg(desktop)]
    crate::commands::show_startup_initialization_error(window.app_handle());
    #[cfg(target_os = "ios")]
    {
        let _ = window.run_on_main_thread(show_native_creation_error);
    }
    #[cfg(target_os = "android")]
    {
        let _ = window.with_webview(|platform| {
            platform.jni_handle().exec(|env, activity, _| {
                if env
                    .call_method(activity, "alookStartupInitializationFailed", "()V", &[])
                    .is_err()
                {
                    let _ = env.exception_clear();
                    eprintln!("native startup error dialog unavailable");
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn queued_continuation_rechecks_cancellation_and_current_document() {
        let startup = StartupRendezvous::new();
        let action = FrameHandoff::bootstrap();
        startup.signal_frame_ready();
        assert!(action.continuation_allowed(&startup, Some(LocalDocument::Bootstrap)));
        for current in [None, Some(LocalDocument::Recovery)] {
            assert!(!action.continuation_allowed(&startup, current));
        }
        startup.abandon();
        assert!(!action.continuation_allowed(&startup, Some(LocalDocument::Bootstrap)));
        let recovery = FrameHandoff {
            document: LocalDocument::Recovery,
        };
        assert!(recovery.continuation_allowed(&startup, Some(LocalDocument::Recovery)));
        assert!(!recovery.continuation_allowed(&startup, Some(LocalDocument::Bootstrap)));
    }
    #[test]
    fn abandoned_bootstrap_never_schedules_or_delivers_native_effects() {
        let startup = StartupRendezvous::new();
        let calls = Cell::new(0);
        startup.abandon();
        assert!(!consume_local_frame(
            &startup,
            LocalDocument::Bootstrap,
            |_| calls.set(1)
        ));
        assert_eq!(calls.get(), 0);
        let startup = StartupRendezvous::new();
        let queued = Cell::new(None);
        consume_local_frame(&startup, LocalDocument::Bootstrap, |action| {
            queued.set(Some(action))
        });
        startup.abandon();
        assert_eq!(
            queued
                .get()
                .unwrap()
                .deliver(&startup, Some(LocalDocument::Bootstrap), || {
                    calls.set(1);
                    true
                }),
            FrameDelivery::Ignored
        );
        assert_eq!(calls.get(), 0);
    }
    #[test]
    fn recovery_reveals_its_own_error_without_reviving_navigation() {
        let startup = StartupRendezvous::new();
        startup.abandon();
        let calls = Cell::new(0);
        assert!(consume_local_frame(
            &startup,
            LocalDocument::Recovery,
            |action| {
                assert_eq!(
                    action.deliver(&startup, Some(LocalDocument::Recovery), || {
                        calls.set(1);
                        true
                    }),
                    FrameDelivery::Ready(false)
                );
            }
        ));
        assert_eq!(calls.get(), 1);
        assert!(!startup.navigation_started.load(Ordering::Acquire));
    }
    #[test]
    fn retired_or_untrusted_documents_cannot_deliver_native_effects() {
        let startup = StartupRendezvous::new();
        let calls = Cell::new(0);
        let action = FrameHandoff {
            document: LocalDocument::Bootstrap,
        };
        for target in [
            "https://alook.ai/c",
            "alook-recovery://evil.test/bootstrap",
            "alook-recovery://localhost/unknown",
            "alook-recovery://localhost/network-error",
        ] {
            assert_eq!(
                action.deliver(
                    &startup,
                    local_document(&Url::parse(target).unwrap()),
                    || {
                        calls.set(1);
                        true
                    }
                ),
                FrameDelivery::Ignored
            );
        }
        assert_eq!(calls.get(), 0);
    }
    #[test]
    fn navigation_waits_for_native_delivery_and_duplicate_effects_are_ignored() {
        let startup = StartupRendezvous::new();
        startup.signal_hooks_ready();
        startup.signal_bootstrap_finished();
        let queued = Cell::new(None);
        consume_local_frame(&startup, LocalDocument::Bootstrap, |action| {
            queued.set(Some(action))
        });
        assert!(!startup.navigation_started.load(Ordering::Acquire));
        let calls = Cell::new(0);
        let action = queued.get().unwrap();
        assert_eq!(
            action.deliver(&startup, Some(LocalDocument::Bootstrap), || {
                assert!(!startup.navigation_started.load(Ordering::Acquire));
                calls.set(1);
                true
            }),
            FrameDelivery::Ready(true)
        );
        assert_eq!(
            action.deliver(&startup, Some(LocalDocument::Bootstrap), || {
                calls.set(2);
                true
            }),
            FrameDelivery::Ignored
        );
        assert_eq!(calls.get(), 1);
        let failed = StartupRendezvous::new();
        assert_eq!(
            action.deliver(&failed, Some(LocalDocument::Bootstrap), || false),
            FrameDelivery::Failed
        );
        assert!(!failed.frame_ready.load(Ordering::Acquire));
        assert!(!failed.navigation_started.load(Ordering::Acquire));
    }
    #[test]
    fn missing_frame_budget_pauses_in_background_and_expires_in_foreground() {
        use std::time::Duration;
        let mut budget = FrameWaitBudget::default();
        let start = std::time::Instant::now();
        let mut clock = ForegroundClock::default();
        clock.set_foreground(start, true);
        assert!(!budget.tick(clock.elapsed(start), true));
        let paused = start + Duration::from_secs(14);
        clock.set_foreground(paused, false);
        let resumed = paused + Duration::from_secs(60);
        clock.set_foreground(resumed, true);
        assert!(!budget.tick(clock.elapsed(resumed), true));
        assert!(budget.tick(clock.elapsed(resumed + Duration::from_secs(1)), true));
    }

    #[test]
    fn missing_frame_budget_ignores_time_before_waiting_and_duplicate_resume() {
        use std::time::Duration;
        let start = std::time::Instant::now();
        let mut clock = ForegroundClock::default();
        let mut budget = FrameWaitBudget::default();
        clock.set_foreground(start, true);
        assert!(!budget.tick(clock.elapsed(start + Duration::from_secs(60)), false));
        assert!(!budget.tick(clock.elapsed(start + Duration::from_secs(61)), true));
        clock.set_foreground(start + Duration::from_secs(70), true);
        assert!(!budget.tick(clock.elapsed(start + Duration::from_secs(75)), true));
        assert!(budget.tick(clock.elapsed(start + Duration::from_secs(76)), true));
    }
}
