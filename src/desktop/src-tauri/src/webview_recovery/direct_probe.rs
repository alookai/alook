use super::*;
use objc2::rc::Retained;
use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, AnyThread,
};
use objc2_foundation::{
    NSBundle, NSData, NSDictionary, NSHTTPURLResponse, NSString, NSURLRequest, NSURL,
};
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::{
    cell::RefCell,
    sync::{Mutex, OnceLock},
};

thread_local! { static NAVIGATION: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) }; }
static CURRENT_NAVIGATION: AtomicUsize = AtomicUsize::new(0);
static TOKEN: OnceLock<String> = OnceLock::new();

fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("QA probe token");
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    })
}

#[cfg(target_os = "ios")]
const QA_ID: &str = "ai.alook.ios.qa.samara.coldstart61.direct";
#[cfg(target_os = "macos")]
const QA_ID: &str = "ai.alook.desktop.qa.samara.coldstart61.direct";
static DISPATCHED: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static OBSERVED: AtomicU64 = AtomicU64::new(u64::MAX);
static MAIN: AtomicUsize = AtomicUsize::new(0);
static STORE: AtomicUsize = AtomicUsize::new(0);
static FALLBACK: AtomicBool = AtomicBool::new(false);
static QUALIFIED: AtomicBool = AtomicBool::new(false);
static SINK: OnceLock<Option<Mutex<ProbeSink>>> = OnceLock::new();

struct ProbeSink {
    file: std::fs::File,
    bytes: usize,
}

const PARSE_SCRIPT: &str = r#"window.__qa61DirectParse={tauriAtParse:typeof window.__TAURI_INTERNALS__?.invoke==='function',geometryAtParse:typeof window.__alookNativeGeometry?.getSnapshot==='function',geometryHandlerAtParse:typeof window.webkit?.messageHandlers?.alookGeometry?.postMessage==='function',origin:location.origin,path:location.pathname,secure:isSecureContext};"#;
const OBSERVE_SCRIPT: &str = r#"(lease => {
  if (document.hidden || Object.hasOwn(window, '__qa61SampleLease') && window.__qa61SampleLease !== lease) return;
  window.__qa61SampleLease = lease;
  const alive = () => !document.hidden && window.__qa61SampleLease === lease;
  const result = window.__qa61DirectResult ??= {
    attempt: lease, parse: window.__qa61DirectParse ?? null, ready: false,
    origin: location.origin, path: location.pathname, secure: isSecureContext,
    tauriPresent: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
    geometryFacadePresent: typeof window.__alookNativeGeometry?.getSnapshot === 'function'
  };
  if (result.attempt !== lease || result.retired) return;
  if (!result.bound) {
    result.bound = true;
    const retire = () => { window.__qa61SampleLease = null; result.retired = true };
    window.addEventListener('pagehide', retire, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) retire() });
  }
  const desktop = window.__qa61DocumentStart?.platform === 'macos';
  (async () => {
    try {
      if (!desktop) {
      if (typeof window.__TAURI__?.event?.listen !== 'function') throw new Error('missing_event_api');
      const unlisten = await window.__TAURI__.event.listen('qa61-direct-probe-' + lease.replaceAll(':', '-'), () => {});
      await unlisten();
      if (!alive()) return;
      result.tauriRoundTrip = true;
      }
    } catch {
      if (!alive()) return;
      result.tauriRoundTrip = false;
    }
    try {
      const handler = window.webkit?.messageHandlers?.alookGeometry;
      result.geometryHandlerPresent = typeof handler?.postMessage === 'function';
      const value = desktop ? await window.__TAURI_INTERNALS__.invoke('native_geometry_snapshot') : result.geometryHandlerPresent ? await handler.postMessage('snapshot') : null;
      if (!alive()) return;
      if (desktop) result.tauriRoundTrip = true;
      result.geometryRoundTrip = !!value && typeof value.caption === 'boolean'
        && ['viewportWidth', 'viewportHeight'].every(key => Number.isFinite(value[key]) && value[key] > 0)
        && ['top', 'right', 'bottom', 'left'].every(key => Number.isFinite(value[key]) && value[key] >= 0)
        && value.left + value.right <= value.viewportWidth && value.top + value.bottom <= value.viewportHeight;
    } catch {
      if (!alive()) return;
      if (desktop) result.tauriRoundTrip = false;
      result.geometryRoundTrip = false;
    }
    try {
      result.swSupported = 'serviceWorker' in navigator;
      if (result.swSupported) {
        const registration = await navigator.serviceWorker.getRegistration('/');
        if (!alive()) return;
        const controller = navigator.serviceWorker.controller;
        result.hasController = !!controller;
        result.controllerPathKnown = !!controller && new URL(controller.scriptURL).pathname === '/sw.js';
        result.hasRegistration = !!registration;
        result.hasActive = !!registration?.active;
        result.activePathKnown = !!registration?.active && new URL(registration.active.scriptURL).pathname === '/sw.js';
        result.scopeSameOrigin = !!registration && new URL(registration.scope).origin === location.origin;
        result.controllerSameOrigin = !!controller && new URL(controller.scriptURL).origin === location.origin;
        result.activeSameOrigin = !!registration?.active && new URL(registration.active.scriptURL).origin === location.origin;
      }
    } catch {
      if (!alive()) return;
      result.swQueryFailed = true;
    }
    try {
      const hash = '0978980b77a02f90345dcebbb4b62a72dcf267f3b4d00a3dcc9b9a3e519888a9';
      const digest = async response => response && response.ok ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('') : null;
      const shell = '/community-shell/' + hash;
      const cached = await caches.match(shell, { ignoreSearch: true });
      const cachedSha = await digest(cached);
      const publicResponse = await fetch(shell, { credentials:'omit', redirect:'error' });
      const publicSha = await digest(publicResponse);
      const swSha = await digest(await fetch('/sw.js', { credentials:'omit', redirect:'error' }));
      if (!alive()) return;
      result.resources = {
        cachedShellSha: cachedSha, publicShellSha: publicSha, swSha,
        publicShellMatched: publicSha === hash, cachedShellMatched: cachedSha === hash,
        documentStart: window.__qa61DocumentStart ?? null,
        stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map(e=>({path:new URL(e.href).pathname, loaded:!!e.sheet})),
        scripts: [...document.querySelectorAll('script[src]')].map(e=>new URL(e.src).pathname),
        completed: performance.getEntriesByType('resource').map(e=>({path:new URL(e.name).pathname,type:e.initiatorType,status:e.responseStatus??null})).slice(0,128),
        emailInputPresent: !!document.querySelector('input[type=email]'),
        signInEntryAvailable: !!document.querySelector('input[type=email]') || [...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Continue with email'&&!e.disabled&&!e.closest('[inert],[aria-hidden=true]'))
      };
    } catch { if (alive()) result.resourceQueryFailed = true; }
    if (alive()) { result.path = location.pathname; result.ready = true; }
  })();
})"#;
const READ_SCRIPT: &str = r#"(lease=>document.hidden||window.__qa61SampleLease!==lease||window.__qa61DirectResult?.attempt!==lease||window.__qa61DirectResult?.retired?null:window.__qa61DirectResult)"#;

fn is_qa<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let mode = std::env::var("ALOOK61_DIRECT_PROBE");
    if !matches!(mode.as_deref(), Ok("tiny" | "control" | "public")) {
        return false;
    }
    let native_matches = NSBundle::mainBundle()
        .bundleIdentifier()
        .is_some_and(|identifier| identifier.to_string() == QA_ID);
    if !native_matches {
        return false;
    }
    SINK.get_or_init(|| {
        let path = window.path().app_log_dir().ok()?;
        std::fs::create_dir_all(&path).ok()?;
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path.join(format!("qa61-direct-{}.jsonl", std::process::id())))
            .ok()?;
        Some(Mutex::new(ProbeSink { file, bytes: 0 }))
    });
    let config_matches = window.config().identifier == QA_ID;
    if !QUALIFIED.swap(true, Ordering::AcqRel) {
        record(
            "qualification",
            serde_json::json!({"nativeIdentityMatched":native_matches,"configIdentityMatched":config_matches,"mode":mode.ok(),"fileSinkOpened":SINK.get().is_some_and(Option::is_some)}),
        );
    }
    config_matches
}

fn enabled<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    is_qa(window)
        && matches!(
            std::env::var("ALOOK61_DIRECT_PROBE").as_deref(),
            Ok("tiny" | "public")
        )
}

fn fallback<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, reason: &'static str) {
    if FALLBACK.swap(true, Ordering::AcqRel) {
        return;
    }
    record(
        "original_url_fallback",
        serde_json::json!({"reason":reason}),
    );
    tauri::async_runtime::spawn(async move {
        let pending = window.clone();
        let _ = window.run_on_main_thread(move || {
            if super::STARTUP.abandoned.load(Ordering::Acquire)
                || !pending.url().is_ok_and(|url| super::is_bootstrap_url(&url))
            {
                return;
            }
            let result = super::initial_replace_script(
                tauri::is_dev(),
                pending.config().build.dev_url.as_ref(),
            )
            .map_err(str::to_owned)
            .and_then(|script| pending.eval(script).map_err(|error| error.to_string()));
            if result.is_err() && super::STARTUP.signal_failure() {
                crate::startup_log::abandon(crate::startup_log::Phase::InitializationFailed);
                let _ = pending.navigate(super::initialization_error_url());
            }
        });
    });
}

fn record(phase: &str, data: serde_json::Value) {
    let value = serde_json::json!({"phase":phase,"pid":std::process::id(),"data":data});
    eprintln!("QA61_DIRECT {value}");
    let Some(Some(sink)) = SINK.get() else { return };
    let Ok(mut sink) = sink.lock() else { return };
    let mut bytes = value.to_string().into_bytes();
    bytes.push(b'\n');
    if sink.bytes + bytes.len() > 131_072 {
        return;
    }
    if sink.file.write_all(&bytes).is_ok() {
        sink.bytes += bytes.len();
        let _ = sink.file.flush();
    }
}

fn target<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<Url, String> {
    super::initial_replace_script(tauri::is_dev(), window.config().build.dev_url.as_ref())
        .map_err(str::to_owned)?;
    Url::parse(if tauri::is_dev() {
        "http://localhost:3000/c"
    } else {
        super::PRODUCTION_TARGET
    })
    .map_err(|error| error.to_string())
}

pub(super) fn try_deliver<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    if !is_qa(window) {
        return false;
    }
    if DISPATCHED.swap(true, Ordering::AcqRel) {
        record("duplicate_suppressed", serde_json::Value::Null);
        return true;
    }
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let dispatched = window.clone();
        if window
            .run_on_main_thread(move || deliver(&dispatched))
            .is_err()
        {
            record("main_thread_dispatch_failed", serde_json::Value::Null);
            fallback(window, "main_thread_dispatch");
        }
    });
    true
}

unsafe fn native_properties(config: *mut AnyObject, store: *mut AnyObject) -> serde_json::Value {
    let persistent: objc2::runtime::Bool = unsafe { msg_send![store, isPersistent] };
    #[cfg(target_os = "ios")]
    let app_bound = {
        let value: objc2::runtime::Bool =
            unsafe { msg_send![config, limitsNavigationsToAppBoundDomains] };
        Some(value.as_bool())
    };
    #[cfg(target_os = "macos")]
    let app_bound = {
        let _ = config;
        None::<bool>
    };
    serde_json::json!({"appBound":app_bound,"persistentStore":persistent.as_bool()})
}

fn deliver<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if super::STARTUP.abandoned.load(Ordering::Acquire) {
        record("abandoned_suppressed", serde_json::Value::Null);
        return;
    }
    let target = match target(window) {
        Ok(target) => target,
        Err(error) => {
            record("target_rejected", serde_json::json!({"error":error}));
            fallback(window.clone(), "target_rejected");
            return;
        }
    };
    let probe_window = window.clone();
    if window.with_webview(move |platform| unsafe {
        if super::STARTUP.abandoned.load(Ordering::Acquire) {
            record("abandoned_at_effect", serde_json::Value::Null);
            return;
        }
        let webview = &*platform.inner().cast::<AnyObject>();
        let current: *mut NSURL = msg_send![webview, URL];
        let current = current.as_ref().and_then(|url| url.absoluteString()).and_then(|url| Url::parse(&url.to_string()).ok());
        if !current.as_ref().is_some_and(super::is_bootstrap_url) {
            record("retired_document_suppressed", serde_json::Value::Null);
            return;
        }
        let config: *mut AnyObject = msg_send![webview, configuration];
        let store: *mut AnyObject = msg_send![config, websiteDataStore];
        MAIN.store(platform.inner() as usize, Ordering::Release);
        STORE.store(store as usize, Ordering::Release);
        record("baseline_identity_captured", serde_json::json!({"mode":std::env::var("ALOOK61_DIRECT_PROBE").ok(),"native":native_properties(config,store)}));
        if let Err(reason) = install_document_probe(webview, config) {
            record("document_probe_rejected", serde_json::json!({"reason":reason}));
            fallback(probe_window.clone(), "document_probe_rejected");
            return;
        }
        if !enabled(&probe_window) {
            fallback(probe_window.clone(), "control_original_url");
            return;
        }
        if !objc2::available!(macos = 12.0, ios = 15.0) {
            record("api_unavailable", serde_json::Value::Null);
            fallback(probe_window.clone(), "api_unavailable");
            return;
        }
        let url = NSURL::URLWithString(&NSString::from_str(target.as_str())).expect("fixed probe URL");
        let request = NSURLRequest::requestWithURL(&url);
        let parse_script = format!("{}window.__qa61DirectParse.attempt={};", PARSE_SCRIPT, serde_json::to_string(token()).expect("fixed token"));
        let hash = STANDARD.encode(Sha256::digest(parse_script.as_bytes()));
        let policy = format!("default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-{hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'");
        let keys = [NSString::from_str("Content-Type"), NSString::from_str("Cache-Control"), NSString::from_str("Content-Security-Policy")];
        let values = [NSString::from_str("text/html; charset=utf-8"), NSString::from_str("no-store"), NSString::from_str(&policy)];
        let headers = NSDictionary::from_slices(&keys.iter().map(|key| &**key).collect::<Vec<_>>(), &values.iter().map(|value| &**value).collect::<Vec<_>>());
        let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(NSHTTPURLResponse::alloc(), &url, 200, Some(&NSString::from_str("HTTP/1.1")), Some(&headers)).expect("fixed probe response");
        let html = format!("<!doctype html><html><head><meta name=viewport content=\"width=device-width,initial-scale=1\"><style>:root{{color-scheme:light dark;background:#faf6ee;color:#222}}@media(prefers-color-scheme:dark){{:root{{background:#000;color:#eee}}}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui}}</style></head><body><main>WKWebView direct-delivery probe</main><script>{parse_script}</script></body></html>");
        let public = std::env::var("ALOOK61_DIRECT_PROBE").as_deref() == Ok("public");
        let body = if public {
            match public_fixture(&probe_window) {
                Ok(body) => body,
                Err(reason) => {
                    record("public_fixture_rejected", serde_json::json!({"reason":reason}));
                    fallback(probe_window.clone(), "public_fixture_rejected");
                    return;
                }
            }
        } else { html.into_bytes() };
        let response = if public {
            let keys = [NSString::from_str("Content-Type"), NSString::from_str("Cache-Control"), NSString::from_str("X-Content-Type-Options"), NSString::from_str("X-Robots-Tag")];
            let values = [NSString::from_str("text/html; charset=utf-8"), NSString::from_str("public, max-age=31536000, immutable"), NSString::from_str("nosniff"), NSString::from_str("noindex")];
            let headers = NSDictionary::from_slices(&keys.iter().map(|key| &**key).collect::<Vec<_>>(), &values.iter().map(|value| &**value).collect::<Vec<_>>());
            NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(NSHTTPURLResponse::alloc(), &url, 200, Some(&NSString::from_str("HTTP/1.1")), Some(&headers)).expect("public QA response")
        } else { response };
        let data = NSData::with_bytes(&body);
        let navigation: *mut AnyObject = msg_send![webview, loadSimulatedRequest: &*request, response: &*response, responseData: &*data];
        NAVIGATION.with(|owned| *owned.borrow_mut() = Retained::retain(navigation));
        record("simulated_request_returned", serde_json::json!({"navigationReturned":!navigation.is_null(),"navigationRetained":NAVIGATION.with(|owned| owned.borrow().is_some()),"attempt":token(),"sameConfiguredMain":probe_window.label()=="main","htmlSha256":format!("{:x}",Sha256::digest(&body)),"publicFixtureNotBusiness":!public,"realPublicShell":public,"bodyBytes":body.len()}));
    }).is_err() {
        record("webview_dispatch_failed", serde_json::Value::Null);
        fallback(window.clone(), "webview_dispatch");
    }
}

pub(super) fn on_page_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    let Some(window) = webview.app_handle().get_webview_window("main") else {
        return;
    };
    if webview.label() != "main" || !is_qa(&window) {
        return;
    }
    let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
    let generation = if started {
        GENERATION.fetch_add(1, Ordering::AcqRel) + 1
    } else {
        GENERATION.load(Ordering::Acquire)
    };
    let expected = target(&window).is_ok_and(|target| {
        target.origin() == payload.url().origin() && !super::is_recovery_url(payload.url())
    });
    record(
        "document_callback",
        serde_json::json!({"started":started,"originMatched":expected,"generation":generation}),
    );
    if !expected || started || OBSERVED.swap(generation, Ordering::AcqRel) == generation {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let pending = window.clone();
        let _ = window.run_on_main_thread(move || observe_finished(pending, generation));
    });
}

fn observe_finished<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, generation: u64) {
    if GENERATION.load(Ordering::Acquire) != generation {
        return;
    }
    let _ = window.with_webview(move |platform| unsafe {
        if GENERATION.load(Ordering::Acquire) != generation { return; }
        let view = &*platform.inner().cast::<AnyObject>();
        let config: *mut AnyObject = msg_send![view, configuration];
        let store: *mut AnyObject = msg_send![config, websiteDataStore];
        record("finished_identity", serde_json::json!({"generation":generation,"sameWebView":MAIN.load(Ordering::Acquire)==platform.inner() as usize,"sameDataStore":STORE.load(Ordering::Acquire)==store as usize,"navigationRetained":NAVIGATION.with(|owned| owned.borrow().is_some()),"simulatedNavigationMatched":navigation_matches(CURRENT_NAVIGATION.load(Ordering::Acquire)),"native":native_properties(config,store)}));
    });
    let expected_origin = target(&window)
        .map(|target| target.origin().ascii_serialization())
        .unwrap_or_default();
    let lease = format!("{}:{generation}", token());
    let encoded_lease = serde_json::to_string(&lease).unwrap();
    let script = format!("(()=>{{if(location.origin!=={}||document.readyState!=='complete')return;if({}&&window.__qa61DirectParse?.attempt!=={})return;({OBSERVE_SCRIPT})({encoded_lease})}})()",serde_json::to_string(&expected_origin).unwrap(),std::env::var("ALOOK61_DIRECT_PROBE").as_deref()==Ok("tiny"),serde_json::to_string(token()).unwrap());
    let require_public = std::env::var("ALOOK61_DIRECT_PROBE").as_deref() != Ok("tiny");
    let reader = format!("({READ_SCRIPT})({encoded_lease})");
    let _ = std::thread::Builder::new().name("qa61-direct-observer".into()).spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        for sample in 0..24 {
            if GENERATION.load(Ordering::Acquire) != generation || std::time::Instant::now() >= deadline { break; }
            std::thread::sleep(std::time::Duration::from_millis(500));
            if GENERATION.load(Ordering::Acquire) != generation { break; }
            if window.eval(script.clone()).is_err() { break; }
            let expected = lease.clone();
            let (sender, receiver) = std::sync::mpsc::channel();
            if window.eval_with_callback(reader.clone(), move |raw| {
                if GENERATION.load(Ordering::Acquire) != generation { return; }
                let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else { let _ = sender.send(true); return; };
                if let Some(inner) = value.as_str() { value = serde_json::from_str(inner).unwrap_or(serde_json::Value::Null); }
                if value.is_null() { let _ = sender.send(true); return; }
                if value.get("attempt").and_then(|value| value.as_str()) != Some(expected.as_str()) || GENERATION.load(Ordering::Acquire) != generation { let _ = sender.send(true); return; }
                let public_ready = !require_public || value.pointer("/resources/signInEntryAvailable").and_then(|v| v.as_bool()) == Some(true);
                let complete = public_ready && value.get("ready").and_then(|value|value.as_bool())==Some(true) && (value.get("swSupported").and_then(|value|value.as_bool())==Some(false) || value.get("hasController").and_then(|value|value.as_bool())==Some(true) && value.get("hasActive").and_then(|value|value.as_bool())==Some(true));
                record("observation",serde_json::json!({"generation":generation,"sample":sample,"result":value}));
                let _ = sender.send(complete);
            }).is_err() { break; }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now()).min(std::time::Duration::from_millis(500));
            if matches!(receiver.recv_timeout(remaining), Ok(true)) { break; }
        }
        record("observer_stopped",serde_json::json!({"generation":generation,"retired":GENERATION.load(Ordering::Acquire)!=generation}));
    });
}

fn public_fixture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<Vec<u8>, String> {
    let path = window
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?
        .join(crate::public_probe_input::FILE);
    crate::public_probe_input::read(&path).map_err(str::to_owned)
}

struct DocumentHooks {
    class: usize,
    originals: [Imp; 2],
    installed: AtomicBool,
}
static DOCUMENT_HOOKS: OnceLock<DocumentHooks> = OnceLock::new();

fn navigation_matches(pointer: usize) -> bool {
    pointer != 0
        && NAVIGATION.with(|navigation| {
            navigation
                .borrow()
                .as_ref()
                .is_some_and(|owned| (&**owned as *const AnyObject as usize) == pointer)
        })
}

unsafe fn install_document_probe(
    webview: &AnyObject,
    config: *mut AnyObject,
) -> Result<(), String> {
    let delegate: *mut AnyObject = unsafe { msg_send![webview, navigationDelegate] };
    let delegate = unsafe { delegate.as_ref() }.ok_or("missing_navigation_delegate")?;
    let class = delegate.class();
    if DOCUMENT_HOOKS.get().is_some() {
        return Err("document_probe_already_installed".into());
    }
    let selectors = [
        sel!(webView:didCommitNavigation:),
        sel!(webView:didFinishNavigation:),
    ];
    let methods = [
        class
            .instance_method(selectors[0])
            .ok_or("missing_commit_method")?,
        class
            .instance_method(selectors[1])
            .ok_or("missing_finish_method")?,
    ];
    let originals = methods.each_ref().map(|method| method.implementation());
    let implementations: [Imp; 2] = unsafe {
        [
            std::mem::transmute(
                document_committed
                    as unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, *mut AnyObject),
            ),
            std::mem::transmute(
                document_finished
                    as unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, *mut AnyObject),
            ),
        ]
    };
    DOCUMENT_HOOKS
        .set(DocumentHooks {
            class: class as *const AnyClass as usize,
            originals,
            installed: AtomicBool::new(false),
        })
        .map_err(|_| "document_probe_recorded")?;
    for (method, implementation) in methods.iter().zip(implementations) {
        unsafe {
            method.set_implementation(implementation);
        }
    }
    if !selectors
        .iter()
        .zip(implementations)
        .all(|(selector, implementation)| {
            class.instance_method(*selector).is_some_and(|method| {
                method.implementation() as *const () == implementation as *const ()
            })
        })
    {
        for (method, original) in methods.iter().zip(originals) {
            unsafe {
                method.set_implementation(original);
            }
        }
        return Err("document_hook_verification".into());
    }
    DOCUMENT_HOOKS
        .get()
        .unwrap()
        .installed
        .store(true, Ordering::Release);
    let script = format!(
        r#"(()=>{{if(location.origin!=='http://localhost:3000')return;window.__qa61DocumentStart={{attempt:{},platform:{},origin:location.origin,path:location.pathname,secure:isSecureContext,tauri:typeof window.__TAURI_INTERNALS__?.invoke==='function',geometryHandler:typeof window.webkit?.messageHandlers?.alookGeometry?.postMessage==='function',runtimeErrorCount:0,errors:[]}};addEventListener('error',e=>{{let t=e.target;if(e.error||e.message)window.__qa61DocumentStart.runtimeErrorCount++;if(t?.src||t?.href){{let a=window.__qa61DocumentStart.errors;if(a.length<32)a.push(new URL(t.src||t.href).pathname)}}}},true)}})()"#,
        serde_json::to_string(token()).unwrap(),
        serde_json::to_string(std::env::consts::OS).unwrap()
    );
    let script_class = AnyClass::get(c"WKUserScript").ok_or("missing_user_script_class")?;
    let allocated: *mut AnyObject = unsafe { msg_send![script_class, alloc] };
    let raw: *mut AnyObject = unsafe {
        msg_send![allocated, initWithSource: &*NSString::from_str(&script), injectionTime: 0isize, forMainFrameOnly: objc2::runtime::Bool::YES]
    };
    let script = unsafe { Retained::from_raw(raw) }.ok_or("user_script_init")?;
    let controller: *mut AnyObject = unsafe { msg_send![config, userContentController] };
    unsafe {
        let _: () = msg_send![controller, addUserScript: &*script];
        let _: () = msg_send![webview, setNavigationDelegate: delegate];
    }
    record(
        "document_probe_installed",
        serde_json::json!({"originalCallbacksPreserved":true,"existingUserScriptsPreserved":true,"attempt":token()}),
    );
    Ok(())
}

unsafe fn document_callback(
    index: usize,
    delegate: &AnyObject,
    selector: Sel,
    webview: &AnyObject,
    navigation: *mut AnyObject,
) {
    let Some(hooks) = DOCUMENT_HOOKS.get() else {
        return;
    };
    let applies = hooks.installed.load(Ordering::Acquire)
        && hooks.class == delegate.class() as *const AnyClass as usize
        && MAIN.load(Ordering::Acquire) == webview as *const AnyObject as usize;
    if applies {
        CURRENT_NAVIGATION.store(navigation as usize, Ordering::Release);
    }
    let original: unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, *mut AnyObject) =
        unsafe { std::mem::transmute(hooks.originals[index]) };
    unsafe {
        original(delegate, selector, webview, navigation);
    }
    if applies {
        record(
            "native_navigation",
            serde_json::json!({"event":if index==0 {"committed"} else {"finished"},"simulatedNavigationMatched":navigation_matches(navigation as usize),"attempt":token()}),
        );
    }
}
unsafe extern "C-unwind" fn document_committed(
    delegate: &AnyObject,
    selector: Sel,
    webview: &AnyObject,
    navigation: *mut AnyObject,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        document_callback(0, delegate, selector, webview, navigation)
    }));
}
unsafe extern "C-unwind" fn document_finished(
    delegate: &AnyObject,
    selector: Sel,
    webview: &AnyObject,
    navigation: *mut AnyObject,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        document_callback(1, delegate, selector, webview, navigation)
    }));
}
