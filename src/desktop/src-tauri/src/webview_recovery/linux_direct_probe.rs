use super::*;
use std::io::Write;
use webkit2gtk::{glib, WebViewExt};

const QA_ID: &str = "ai.alook.desktop.qa.samara.coldstart61.direct";
static DISPATCHED: AtomicBool = AtomicBool::new(false);

fn record<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, phase: &str) {
    let Ok(directory) = window.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(format!("qa61-linux-direct-{}.jsonl", std::process::id()));
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 8192) {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let value = serde_json::json!({"phase":phase,"pid":std::process::id(),"publicHash":crate::public_probe_input::SHA256,"runtimeAcceptance":"not_inferred"});
        let _ = writeln!(file, "{value}");
    }
}

fn fail<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if STARTUP.signal_failure() {
        crate::startup_log::abandon(crate::startup_log::Phase::InitializationFailed);
        let _ = window.navigate(initialization_error_url());
    }
}

fn original<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if STARTUP.abandoned.load(Ordering::Acquire)
        || !window.url().is_ok_and(|url| is_bootstrap_url(&url))
    {
        return;
    }
    match initial_replace_script(tauri::is_dev(), window.config().build.dev_url.as_ref()) {
        Ok(script) => {
            if window.eval(script).is_err() {
                fail(window);
            }
        }
        Err(_) => fail(window),
    }
}

pub(super) fn try_deliver<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    if window.config().identifier != QA_ID {
        return false;
    }
    match std::env::var("ALOOK61_DIRECT_PROBE").as_deref() {
        Ok("control") => {
            record(window, "original_url_control");
            return false;
        }
        Ok("public") => {}
        _ => return false,
    }
    let body = window.path().app_log_dir().ok().and_then(|directory| {
        crate::public_probe_input::read(&directory.join(crate::public_probe_input::FILE)).ok()
    });
    let Some(body) = body else {
        record(window, "public_fixture_rejected_original_url");
        return false;
    };
    if DISPATCHED.swap(true, Ordering::AcqRel) {
        return true;
    }
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let queued = window.clone();
        if window
            .run_on_main_thread(move || {
                if STARTUP.abandoned.load(Ordering::Acquire)
                    || !queued.url().is_ok_and(|url| is_bootstrap_url(&url))
                {
                    record(&queued, "retired_document_suppressed");
                    return;
                }
                let target = if tauri::is_dev() {
                    "http://localhost:3000/c"
                } else {
                    PRODUCTION_TARGET
                };
                let observed = queued.clone();
                if queued
                    .with_webview(move |platform| {
                        let view = platform.inner();
                        if STARTUP.abandoned.load(Ordering::Acquire)
                            || !view
                                .uri()
                                .and_then(|uri| Url::parse(&uri).ok())
                                .is_some_and(|url| is_bootstrap_url(&url))
                        {
                            record(&observed, "native_document_retired");
                            return;
                        }
                        view.load_bytes(
                            &glib::Bytes::from_owned(body),
                            Some("text/html"),
                            Some("UTF-8"),
                            Some(target),
                        );
                        record(&observed, "load_bytes_requested");
                    })
                    .is_err()
                {
                    record(&queued, "native_dispatch_failed_original_url");
                    original(&queued);
                }
            })
            .is_err()
        {
            record(&window, "main_thread_dispatch_failed");
            fail(&window);
        }
    });
    true
}
