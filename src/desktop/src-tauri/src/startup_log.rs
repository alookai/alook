#[cfg(any(target_os = "ios", test))]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
#[cfg(any(target_os = "ios", test))]
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    #[cfg(any(target_os = "ios", test))]
    NativeEntry,
    RustEntry,
    BuilderBegin,
    BuilderReturned,
    SetupEnter,
    SetupReturned,
    #[cfg(windows)]
    EnvironmentRequested,
    #[cfg(windows)]
    EnvironmentReady,
    #[cfg(windows)]
    EnvironmentFallback,
    #[cfg(windows)]
    MainWindowCreated,
    #[cfg(windows)]
    BootstrapMapped,
    #[cfg(windows)]
    BootstrapMappingFallback,
    HooksDispatch,
    HooksReady,
    BootstrapStarted,
    BootstrapFinished,
    BootstrapFrameReceived,
    #[cfg(target_os = "ios")]
    NativeContainerReady,
    BusinessRequest,
    BusinessStarted,
    BusinessFinishedCallback,
    BusinessFinishedUnpaired,
    NativeHandoffDispatch,
    NativeHandoffReturned,
    InitializationFailed,
    RecoveryEntered,
    #[cfg(any(mobile, test))]
    RetainedProcessResumed,
    ProcessExit,
}

#[derive(Clone, Serialize)]
struct Event {
    phase: Phase,
    elapsed_us: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum NavigationOutcome {
    NotRequested,
    AwaitingStart,
    Loading,
    FinishedCallback,
    InterruptedOrRedirected,
    MismatchedCompletion,
    Recovery,
    InitializationFailed,
}

struct Recorder {
    launch_id: String,
    started_at_unix_ms: u128,
    events: Vec<Event>,
    navigation: NavigationOutcome,
    pending_document: Option<String>,
    native_handoff_failed: bool,
    #[cfg(any(mobile, test))]
    suspended: bool,
}

#[derive(Serialize)]
struct Summary<'a> {
    schema_version: u8,
    launch_id: &'a str,
    started_at_unix_ms: u128,
    version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    origin: &'static str,
    launch_condition: &'static str,
    events: &'a [Event],
    navigation_outcome: NavigationOutcome,
    native_handoff_failed: bool,
    native_handoff_observation: &'static str,
    android_engine: Option<AndroidTiming>,
    hooks_attach_us: Option<u64>,
    bootstrap_document_us: Option<u64>,
    business_request_to_finished_callback_us: Option<u64>,
    native_handoff_us: Option<u64>,
    first_presented_frame_us: Option<u64>,
    business_ready_received_us: Option<u64>,
    first_input_response_us: Option<u64>,
    unmeasured: [&'static str; 4],
}

impl Recorder {
    fn new() -> Self {
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let mut random = [0u8; 16];
        let launch_id = if getrandom::fill(&mut random).is_ok() {
            random.iter().map(|byte| format!("{byte:02x}")).collect()
        } else {
            format!("{:x}-{:x}", started.as_nanos(), std::process::id())
        };
        Self {
            launch_id,
            started_at_unix_ms: started.as_millis(),
            events: Vec::with_capacity(18),
            navigation: NavigationOutcome::NotRequested,
            pending_document: None,
            native_handoff_failed: false,
            #[cfg(any(mobile, test))]
            suspended: false,
        }
    }

    fn mark(&mut self, phase: Phase, elapsed_us: u64) {
        if matches!(
            phase,
            Phase::NativeHandoffDispatch | Phase::NativeHandoffReturned
        ) && matches!(
            self.navigation,
            NavigationOutcome::InitializationFailed | NavigationOutcome::Recovery
        ) && !self
            .events
            .iter()
            .any(|event| event.phase == Phase::NativeHandoffDispatch)
        {
            return;
        }
        if !matches!(
            self.navigation,
            NavigationOutcome::NotRequested
                | NavigationOutcome::AwaitingStart
                | NavigationOutcome::Loading
        ) && !matches!(
            phase,
            Phase::NativeHandoffDispatch
                | Phase::NativeHandoffReturned
                | Phase::InitializationFailed
                | Phase::RecoveryEntered
                | Phase::ProcessExit
        ) {
            #[cfg(any(mobile, test))]
            if phase == Phase::RetainedProcessResumed {
                if !self.events.iter().any(|event| event.phase == phase) {
                    self.events.push(Event { phase, elapsed_us });
                }
            }
            return;
        }
        if !self.events.iter().any(|event| event.phase == phase) {
            self.events.push(Event { phase, elapsed_us });
        }
    }

    fn interval(&self, from: Phase, to: Phase) -> Option<u64> {
        let start = self.events.iter().find(|event| event.phase == from)?;
        let end = self.events.iter().find(|event| event.phase == to)?;
        end.elapsed_us.checked_sub(start.elapsed_us)
    }

    fn native_handoff(&mut self, completed: bool, elapsed_us: u64) {
        if !self
            .events
            .iter()
            .any(|event| event.phase == Phase::NativeHandoffDispatch)
        {
            return;
        }
        if completed {
            self.mark(Phase::NativeHandoffReturned, elapsed_us);
        } else {
            self.native_handoff_failed = true;
        }
    }

    fn request(&mut self, elapsed_us: u64) {
        if self.navigation == NavigationOutcome::NotRequested {
            self.navigation = NavigationOutcome::AwaitingStart;
            self.mark(Phase::BusinessRequest, elapsed_us);
        }
    }

    fn document(&mut self, started: bool, document: &str, elapsed_us: u64) {
        match (self.navigation, started) {
            (NavigationOutcome::AwaitingStart, true) => {
                self.navigation = NavigationOutcome::Loading;
                self.pending_document = Some(document.to_owned());
                self.mark(Phase::BusinessStarted, elapsed_us);
            }
            (NavigationOutcome::Loading, true) => {
                self.navigation = NavigationOutcome::InterruptedOrRedirected;
                self.pending_document = None;
            }
            (NavigationOutcome::Loading, false) => {
                self.navigation = if self.pending_document.as_deref() == Some(document) {
                    self.mark(Phase::BusinessFinishedCallback, elapsed_us);
                    NavigationOutcome::FinishedCallback
                } else {
                    self.mark(Phase::BusinessFinishedUnpaired, elapsed_us);
                    NavigationOutcome::MismatchedCompletion
                };
                self.pending_document = None;
            }
            _ => {}
        }
    }

    fn abandon(&mut self, phase: Phase, elapsed_us: u64) {
        if matches!(
            self.navigation,
            NavigationOutcome::NotRequested
                | NavigationOutcome::AwaitingStart
                | NavigationOutcome::Loading
        ) {
            self.navigation = if phase == Phase::RecoveryEntered {
                NavigationOutcome::Recovery
            } else {
                NavigationOutcome::InitializationFailed
            };
            self.pending_document = None;
            self.mark(phase, elapsed_us);
        }
    }

    #[cfg(any(mobile, test))]
    fn lifecycle(&mut self, resumed: bool, elapsed_us: u64) -> bool {
        if !resumed {
            self.suspended = true;
            return false;
        }
        let suspended = std::mem::replace(&mut self.suspended, false);
        if suspended {
            self.mark(Phase::RetainedProcessResumed, elapsed_us);
        }
        suspended
    }

    fn origin(&self) -> &'static str {
        #[cfg(any(target_os = "ios", test))]
        if self
            .events
            .first()
            .is_some_and(|event| event.phase == Phase::NativeEntry)
        {
            return "ios_main_entry_monotonic";
        }
        "rust_run_entry_monotonic"
    }

    fn summary(&self) -> Summary<'_> {
        Summary {
            schema_version: 1,
            launch_id: &self.launch_id,
            started_at_unix_ms: self.started_at_unix_ms,
            version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            origin: self.origin(),
            launch_condition: "new_process_cache_state_unknown",
            events: &self.events,
            navigation_outcome: self.navigation,
            native_handoff_failed: self.native_handoff_failed,
            native_handoff_observation: if self.native_handoff_failed {
                "failed_callback"
            } else if self
                .events
                .iter()
                .any(|event| event.phase == Phase::NativeHandoffReturned)
            {
                "native_callback_return_not_presentation"
            } else {
                "not_observed"
            },
            android_engine: android_timing(),
            hooks_attach_us: self.interval(Phase::HooksDispatch, Phase::HooksReady),
            bootstrap_document_us: self.interval(Phase::BootstrapStarted, Phase::BootstrapFinished),
            business_request_to_finished_callback_us: self
                .interval(Phase::BusinessRequest, Phase::BusinessFinishedCallback),
            native_handoff_us: self
                .interval(Phase::NativeHandoffDispatch, Phase::NativeHandoffReturned),
            first_presented_frame_us: None,
            business_ready_received_us: None,
            first_input_response_us: None,
            unmeasured: [
                "os_process_creation_not_observed",
                "compositor_presentation_not_observed",
                "business_readiness_not_reported",
                "real_input_response_not_observed",
            ],
        }
    }
}

#[derive(Clone, Serialize)]
struct AndroidTiming {
    clock: &'static str,
    origin: &'static str,
    async_requested_after_entry_us: Option<u64>,
    async_completed_after_entry_us: Option<u64>,
    async_duration_us: Option<u64>,
    webview_created_callback_after_entry_us: Option<u64>,
    ui_blocking_call_sites: Option<u64>,
    outcome: &'static str,
}

#[cfg(target_os = "android")]
static ANDROID_TIMING: Mutex<Option<AndroidTiming>> = Mutex::new(None);

fn android_timing() -> Option<AndroidTiming> {
    #[cfg(target_os = "android")]
    {
        ANDROID_TIMING
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn alook_startup_native_entry() {
    mark(Phase::NativeEntry);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_ai_alook_android_StartupLog_recordTiming(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    requested: i64,
    completed: i64,
    webview: i64,
    blocking_sites: i32,
    outcome: i32,
) {
    let requested = u64::try_from(requested).ok();
    let completed = u64::try_from(completed).ok();
    let timing = AndroidTiming {
        clock: "android_elapsed_realtime",
        origin: "application_on_create",
        async_requested_after_entry_us: requested,
        async_completed_after_entry_us: completed,
        async_duration_us: requested
            .zip(completed)
            .and_then(|(start, end)| end.checked_sub(start)),
        webview_created_callback_after_entry_us: u64::try_from(webview).ok(),
        ui_blocking_call_sites: u64::try_from(blocking_sites).ok(),
        outcome: match outcome {
            1 => "callback_success",
            2 => "callback_failure",
            _ => "pending",
        },
    };
    *ANDROID_TIMING
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(timing);
    if RECORDER.get().is_some() {
        publish();
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_ai_alook_android_StartupLog_foregroundChanged(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    active: u8,
) {
    crate::webview_recovery::set_foreground(active != 0);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_ai_alook_android_StartupLog_handoffBegin(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) {
    mark(Phase::NativeHandoffDispatch);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_ai_alook_android_StartupLog_handoffReturned(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) {
    native_handoff(true);
}

static START: OnceLock<Instant> = OnceLock::new();
static RECORDER: OnceLock<Mutex<Recorder>> = OnceLock::new();

fn update<T>(action: impl FnOnce(&mut Recorder, u64) -> T) -> T {
    let start = START.get_or_init(Instant::now);
    let mut recorder = RECORDER
        .get_or_init(|| Mutex::new(Recorder::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let elapsed = u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);
    action(&mut recorder, elapsed)
}

pub(crate) fn mark(phase: Phase) {
    update(|recorder, elapsed| {
        recorder.mark(
            phase,
            if recorder.events.is_empty() {
                0
            } else {
                elapsed
            },
        )
    });
}

pub(crate) fn request() {
    update(Recorder::request);
}

pub(crate) fn document(started: bool, document: &str, trusted: bool) {
    let changed = update(|recorder, elapsed| {
        let previous = recorder.navigation;
        if trusted {
            recorder.document(started, document, elapsed);
        } else if matches!(
            previous,
            NavigationOutcome::AwaitingStart | NavigationOutcome::Loading
        ) {
            recorder.navigation = NavigationOutcome::InterruptedOrRedirected;
            recorder.pending_document = None;
        }
        recorder.navigation != previous
    });
    if changed && !started {
        publish();
    }
}

pub(crate) fn abandon(phase: Phase) {
    let changed = update(|recorder, elapsed| {
        let previous = recorder.navigation;
        recorder.abandon(phase, elapsed);
        recorder.navigation != previous
    });
    if changed {
        publish();
    }
}

#[cfg(mobile)]
pub(crate) fn lifecycle(resumed: bool) {
    if update(|recorder, elapsed| recorder.lifecycle(resumed, elapsed)) {
        publish();
    }
}

pub(crate) fn native_handoff(completed: bool) {
    update(|recorder, elapsed| recorder.native_handoff(completed, elapsed));
    publish();
}

#[cfg(any(target_os = "ios", test))]
fn system_records(launch_id: &str, summary: &str) -> Vec<String> {
    #[derive(Serialize)]
    struct Part<'a> {
        schema_version: u8,
        kind: &'static str,
        pid: u32,
        launch_id: &'a str,
        summary_sha256: &'a str,
        summary_bytes: usize,
        part: usize,
        parts: usize,
        encoding: &'static str,
        data: String,
    }
    let hash = format!("{:x}", Sha256::digest(summary.as_bytes()));
    if summary.len() > 20_480 {
        return Vec::new();
    }
    let parts = summary.len().div_ceil(320);
    summary
        .as_bytes()
        .chunks(320)
        .enumerate()
        .filter_map(|(index, bytes)| {
            serde_json::to_string(&Part {
                schema_version: 1,
                kind: "startup_summary_chunk",
                pid: std::process::id(),
                launch_id,
                summary_sha256: &hash,
                summary_bytes: summary.len(),
                part: index + 1,
                parts,
                encoding: "base64",
                data: STANDARD.encode(bytes),
            })
            .ok()
        })
        .collect()
}

pub(crate) fn publish() {
    update(|recorder, _| {
        if let Ok(summary) = serde_json::to_string(&recorder.summary()) {
            #[cfg(target_os = "ios")]
            for record in system_records(&recorder.launch_id, &summary) {
                unsafe extern "C" {
                    fn alook_startup_system_log(bytes: *const u8, length: usize);
                }
                unsafe {
                    alook_startup_system_log(record.as_ptr(), record.len());
                }
            }
            log::info!(target: "alook_startup", "{summary}");
        }
    });
}

fn log_plugin<R: tauri::Runtime>(file: bool) -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
    let mut targets = vec![Target::new(TargetKind::Stdout)];
    if file {
        targets.push(Target::new(TargetKind::LogDir {
            file_name: Some("startup".into()),
        }));
    }
    tauri_plugin_log::Builder::new()
        .targets(targets)
        .level(log::LevelFilter::Info)
        .filter(|metadata| metadata.target() == "alook_startup")
        .clear_format()
        .max_file_size(65_536)
        .rotation_strategy(RotationStrategy::KeepOne)
        .build()
}

pub(crate) fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if app.plugin(log_plugin(true)).is_err() {
        eprintln!("startup log file unavailable; using system output");
        if app.plugin(log_plugin(false)).is_err() {
            eprintln!("startup log unavailable");
        }
    }
    publish();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_records_are_bounded_and_restore_exact_json_bytes() {
        let mut recorder = Recorder::new();
        recorder.mark(Phase::RustEntry, 0);
        recorder.request(10);
        recorder.document(true, "https://alook.ai/c", 20);
        recorder.document(false, "https://alook.ai/c", 30);
        let canonical = serde_json::to_string(&recorder.summary()).unwrap();
        let multibyte = serde_json::json!({"value":"é🦀".repeat(700)}).to_string();
        for summary in [canonical, multibyte] {
            let records = system_records(&recorder.launch_id, &summary);
            assert!(records.len() > 1);
            let expected_hash = format!("{:x}", Sha256::digest(summary.as_bytes()));
            let mut restored = Vec::new();
            for (index, record) in records.iter().enumerate() {
                assert!(record.len() <= 768);
                let value: serde_json::Value = serde_json::from_str(record).unwrap();
                assert_eq!(value["schema_version"], 1);
                assert_eq!(value["kind"], "startup_summary_chunk");
                assert_eq!(value["pid"], std::process::id());
                assert_eq!(value["launch_id"], recorder.launch_id);
                assert_eq!(value["summary_sha256"], expected_hash);
                assert_eq!(value["summary_bytes"], summary.len());
                assert_eq!(value["part"], index + 1);
                assert_eq!(value["parts"], records.len());
                assert_eq!(value["encoding"], "base64");
                restored.extend(STANDARD.decode(value["data"].as_str().unwrap()).unwrap());
            }
            assert_eq!(restored, summary.as_bytes());
        }
        assert!(system_records(&recorder.launch_id, &"x".repeat(20_481)).is_empty());
    }

    #[test]
    fn completion_uses_matched_endpoints_and_never_overwrites_them() {
        let mut recorder = Recorder::new();
        recorder.request(20);
        recorder.document(true, "https://alook.ai/c", 30);
        recorder.document(false, "https://alook.ai/c", 120);
        recorder.request(150);
        recorder.document(true, "https://alook.ai/c/another", 160);
        recorder.document(false, "https://alook.ai/c/another", 800);
        let summary = recorder.summary();
        assert_eq!(
            summary.navigation_outcome,
            NavigationOutcome::FinishedCallback
        );
        assert_eq!(summary.business_request_to_finished_callback_us, Some(100));
        assert_eq!(summary.first_presented_frame_us, None);
        assert_eq!(summary.first_input_response_us, None);
    }

    #[test]
    fn cancelled_failed_or_mismatched_navigation_cannot_become_a_success() {
        for outcome in [
            NavigationOutcome::InterruptedOrRedirected,
            NavigationOutcome::Recovery,
            NavigationOutcome::InitializationFailed,
            NavigationOutcome::MismatchedCompletion,
        ] {
            let mut recorder = Recorder::new();
            recorder.request(20);
            recorder.document(true, "first", 30);
            match outcome {
                NavigationOutcome::InterruptedOrRedirected => recorder.document(true, "second", 40),
                NavigationOutcome::Recovery => recorder.abandon(Phase::RecoveryEntered, 40),
                NavigationOutcome::InitializationFailed => {
                    recorder.abandon(Phase::InitializationFailed, 40)
                }
                _ => recorder.document(false, "different", 40),
            }
            recorder.request(45);
            recorder.document(true, "first", 50);
            recorder.document(false, "first", 60);
            assert_eq!(recorder.summary().navigation_outcome, outcome);
            assert_eq!(
                recorder.summary().business_request_to_finished_callback_us,
                None
            );
        }
    }

    #[test]
    fn missing_or_reversed_intervals_remain_unmeasured() {
        let mut recorder = Recorder::new();
        recorder.mark(Phase::HooksReady, 10);
        assert_eq!(recorder.summary().hooks_attach_us, None);
        recorder.mark(Phase::HooksDispatch, 20);
        assert_eq!(recorder.summary().hooks_attach_us, None);
        recorder.mark(Phase::HooksReady, 30);
        assert_eq!(recorder.summary().hooks_attach_us, None);
        assert_eq!(recorder.events.len(), 2);
    }

    #[test]
    fn late_phase_callbacks_do_not_repair_abandoned_startup() {
        let mut recorder = Recorder::new();
        recorder.mark(Phase::BootstrapStarted, 10);
        recorder.mark(Phase::HooksDispatch, 20);
        recorder.abandon(Phase::InitializationFailed, 30);
        recorder.mark(Phase::BootstrapFinished, 40);
        recorder.mark(Phase::HooksReady, 50);
        recorder.mark(Phase::NativeHandoffDispatch, 60);
        recorder.native_handoff(true, 70);
        recorder.native_handoff(false, 80);
        assert_eq!(recorder.summary().bootstrap_document_us, None);
        assert_eq!(recorder.summary().hooks_attach_us, None);
        assert_eq!(recorder.summary().native_handoff_us, None);
        assert!(!recorder.summary().native_handoff_failed);
        assert_eq!(
            recorder.summary().navigation_outcome,
            NavigationOutcome::InitializationFailed
        );
    }

    #[test]
    fn handoff_return_belongs_to_a_previously_started_native_operation() {
        let mut recorder = Recorder::new();
        recorder.native_handoff(true, 10);
        recorder.native_handoff(false, 15);
        assert_eq!(recorder.summary().native_handoff_us, None);
        assert!(!recorder.summary().native_handoff_failed);
        recorder.mark(Phase::NativeHandoffDispatch, 20);
        recorder.abandon(Phase::InitializationFailed, 30);
        recorder.native_handoff(true, 40);
        assert_eq!(recorder.summary().native_handoff_us, Some(20));
        assert_eq!(
            recorder.summary().navigation_outcome,
            NavigationOutcome::InitializationFailed
        );
    }

    #[test]
    fn ios_native_entry_and_rust_entry_keep_distinct_boundaries() {
        let mut recorder = Recorder::new();
        recorder.mark(Phase::NativeEntry, 0);
        recorder.mark(Phase::RustEntry, 120);
        assert_eq!(recorder.summary().origin, "ios_main_entry_monotonic");
        assert_eq!(
            recorder.interval(Phase::NativeEntry, Phase::RustEntry),
            Some(120)
        );
    }

    #[test]
    fn initial_resume_is_not_a_retained_process_resume() {
        let mut recorder = Recorder::new();
        assert!(!recorder.lifecycle(true, 10));
        assert!(!recorder.lifecycle(false, 20));
        assert!(recorder.lifecycle(true, 30));
        assert!(!recorder.lifecycle(true, 40));
        let event = recorder
            .events
            .iter()
            .find(|event| event.phase == Phase::RetainedProcessResumed)
            .unwrap();
        assert_eq!(event.elapsed_us, 30);
    }

    #[test]
    fn serialized_summary_omits_document_contents_and_reports_missing_observations() {
        let mut recorder = Recorder::new();
        recorder.request(1);
        recorder.document(true, "https://alook.ai/c?credential=private-value", 2);
        let value = serde_json::to_value(recorder.summary()).unwrap();
        let encoded = value.to_string();
        assert!(!encoded.contains("private-value"));
        assert!(!encoded.contains("https://"));
        assert!(value["business_ready_received_us"].is_null());
        assert_eq!(value["unmeasured"].as_array().unwrap().len(), 4);
        assert!(!value["launch_id"].as_str().unwrap().is_empty());
    }
}
