use std::sync::atomic::{AtomicBool, Ordering};
use tauri::http::{Request, Response, StatusCode};
use url::Url;

pub const SCHEME: &str = "alook-recovery";
const HOST: &str = "alook-recovery.localhost";
const BOOTSTRAP_PATH: &str = "/bootstrap";
const RECOVERY_PATH: &str = "/network-error";
const PRODUCTION_TARGET: &str = "https://alook.ai/c";
static STARTUP: StartupRendezvous = StartupRendezvous::new();

struct StartupRendezvous {
    hooks_ready: AtomicBool,
    bootstrap_finished: AtomicBool,
    navigation_started: AtomicBool,
}

impl StartupRendezvous {
    const fn new() -> Self {
        Self {
            hooks_ready: AtomicBool::new(false),
            bootstrap_finished: AtomicBool::new(false),
            navigation_started: AtomicBool::new(false),
        }
    }

    fn signal_hooks_ready(&self) -> bool {
        self.hooks_ready.store(true, Ordering::Release);
        self.claim_navigation()
    }

    fn signal_bootstrap_finished(&self) -> bool {
        self.bootstrap_finished.store(true, Ordering::Release);
        self.claim_navigation()
    }

    fn claim_navigation(&self) -> bool {
        self.hooks_ready.load(Ordering::Acquire)
            && self.bootstrap_finished.load(Ordering::Acquire)
            && !self.navigation_started.swap(true, Ordering::AcqRel)
    }
}

pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(SCHEME, |_context, request| response(request))
}

fn response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let (status, csp, body) = match request.uri().path() {
        BOOTSTRAP_PATH => (
            StatusCode::OK,
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            bootstrap_html(),
        ),
        RECOVERY_PATH => (
            StatusCode::OK,
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            recovery_html(),
        ),
        _ => (
            StatusCode::NOT_FOUND,
            "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "",
        ),
    };
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", csp)
        .body(body.as_bytes().to_vec())
        .expect("recovery response must be valid")
}

#[cfg(any(not(target_os = "android"), test))]
fn accepts_target(target: &str) -> bool {
    Url::parse(target).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && !is_recovery_url(&url)
    })
}

fn is_recovery_url(url: &Url) -> bool {
    url.scheme() == SCHEME
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some(HOST))
}

fn is_bootstrap_url(url: &Url) -> bool {
    is_recovery_url(url) && url.path() == BOOTSTRAP_PATH
}

#[cfg(any(not(target_os = "android"), test))]
fn recovery_url_for(target: &str, http_transport: bool) -> Option<Url> {
    if !accepts_target(target) {
        return None;
    }
    let base = if http_transport {
        format!("http://{HOST}{RECOVERY_PATH}")
    } else {
        format!("{SCHEME}://localhost{RECOVERY_PATH}")
    };
    let mut recovery = Url::parse(&base).ok()?;
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("target", target)
        .finish();
    recovery.set_fragment(Some(&fragment));
    Some(recovery)
}

#[cfg(windows)]
fn recovery_url(target: &str) -> Option<Url> {
    recovery_url_for(target, true)
}

#[cfg(not(any(windows, target_os = "android")))]
fn recovery_url(target: &str) -> Option<Url> {
    recovery_url_for(target, false)
}

#[cfg(test)]
fn android_recovers(error_code: i32) -> bool {
    matches!(error_code, -2 | -6 | -7 | -8 | -11)
}

#[cfg(any(target_os = "macos", target_os = "ios", test))]
fn apple_recovers(error_code: isize) -> bool {
    matches!(
        error_code,
        -1001
            | -1003
            | -1004
            | -1005
            | -1006
            | -1009
            | -1200
            | -1201
            | -1202
            | -1203
            | -1204
            | -1205
            | -1206
            | -2000
    )
}

#[cfg(any(windows, test))]
fn windows_recovers(error_code: i32) -> bool {
    matches!(error_code, 1..=7 | 9..=13)
}

pub fn attach(window: &tauri::WebviewWindow) {
    let startup_window = window.clone();
    if let Err(error) = window.with_webview(move |webview| match platform::attach(webview) {
        Ok(()) if !tauri::is_dev() && STARTUP.signal_hooks_ready() => {
            navigate_window_to_production(&startup_window)
        }
        Ok(()) => {}
        Err(error) => eprintln!("webview recovery unavailable: {error}"),
    }) {
        eprintln!("webview recovery unavailable: {error}");
    }
}

pub fn on_page_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if webview.label() != "main"
        || tauri::is_dev()
        || !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
        || !is_bootstrap_url(payload.url())
    {
        return;
    }
    if STARTUP.signal_bootstrap_finished() {
        navigate_webview_to_production(webview);
    }
}

fn production_target() -> Url {
    Url::parse(PRODUCTION_TARGET).expect("production target must be a valid URL")
}

fn navigate_window_to_production(window: &tauri::WebviewWindow) {
    if let Err(error) = window.navigate(production_target()) {
        eprintln!("webview recovery initial navigation unavailable: {error}");
    }
}

fn navigate_webview_to_production<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    if let Err(error) = webview.navigate(production_target()) {
        eprintln!("webview recovery initial navigation unavailable: {error}");
    }
}

fn bootstrap_html() -> &'static str {
    r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Alook</title><style>:root{color-scheme:light dark;--background:oklch(1 0 0);background:var(--background)}html,body{min-height:100%;margin:0;background:var(--background)}@media(prefers-color-scheme:dark){:root{--background:oklch(0.16 0.008 60)}}</style></head><body></body></html>"#
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use std::{ffi::c_void, panic::AssertUnwindSafe};

    use super::{accepts_target, apple_recovers, recovery_url};
    use objc2::{
        ffi::{
            class_addMethod, objc_getAssociatedObject, objc_setAssociatedObject,
            OBJC_ASSOCIATION_ASSIGN,
        },
        msg_send,
        runtime::{AnyClass, AnyObject, Imp, Sel},
        sel,
    };
    use objc2_foundation::{
        NSError, NSString, NSURLErrorDomain, NSURLErrorFailingURLErrorKey, NSURLRequest, NSURL,
    };

    static MAIN_WEBVIEW_MARKER: u8 = 0;

    pub fn attach(platform: tauri::webview::PlatformWebview) -> Result<(), String> {
        let webview = unsafe { webview_object(platform.inner()) };
        let delegate: *mut AnyObject = unsafe { msg_send![webview, navigationDelegate] };
        let delegate = unsafe { delegate.as_ref() }
            .ok_or_else(|| "missing Wry navigation delegate".to_string())?;
        let delegate_class = delegate.class() as *const AnyClass as *mut AnyClass;

        unsafe {
            objc_setAssociatedObject(
                webview as *const AnyObject as *mut AnyObject,
                marker_key(),
                webview as *const AnyObject as *mut AnyObject,
                OBJC_ASSOCIATION_ASSIGN,
            );
            add_failure_method(
                delegate_class,
                sel!(webView:didFailProvisionalNavigation:withError:),
            )?;
            add_failure_method(delegate_class, sel!(webView:didFailNavigation:withError:))?;
            let _: () = msg_send![webview, setNavigationDelegate: delegate];
        }

        Ok(())
    }

    fn marker_key() -> *const c_void {
        std::ptr::addr_of!(MAIN_WEBVIEW_MARKER).cast()
    }

    #[cfg(target_os = "macos")]
    unsafe fn webview_object<'a>(pointer: *mut c_void) -> &'a AnyObject {
        let webview = &*pointer.cast::<objc2_web_kit::WKWebView>();
        &*(webview as *const objc2_web_kit::WKWebView).cast::<AnyObject>()
    }

    #[cfg(target_os = "ios")]
    unsafe fn webview_object<'a>(pointer: *mut c_void) -> &'a AnyObject {
        &*pointer.cast::<AnyObject>()
    }

    unsafe fn add_failure_method(class: *mut AnyClass, selector: Sel) -> Result<(), String> {
        let implementation: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, *mut AnyObject, &NSError),
            Imp,
        >(did_fail_navigation);
        if bool::from(class_addMethod(
            class,
            selector,
            implementation,
            b"v@:@@@\0".as_ptr().cast(),
        )) {
            Ok(())
        } else {
            Err("failed to install WebKit navigation failure hook".to_string())
        }
    }

    unsafe extern "C-unwind" fn did_fail_navigation(
        _delegate: &AnyObject,
        _selector: Sel,
        webview: &AnyObject,
        _navigation: *mut AnyObject,
        error: &NSError,
    ) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| unsafe {
            handle_failure(webview, error)
        }));
    }

    unsafe fn handle_failure(webview: &AnyObject, error: &NSError) {
        if objc_getAssociatedObject(webview, marker_key()).is_null()
            || !error.domain().isEqualToString(NSURLErrorDomain)
            || !apple_recovers(error.code())
        {
            return;
        }

        let target = error
            .userInfo()
            .objectForKey(NSURLErrorFailingURLErrorKey)
            .and_then(|value| value.downcast::<NSURL>().ok())
            .or_else(|| msg_send![webview, URL])
            .and_then(|url| url.absoluteString())
            .map(|value| value.to_string());
        let Some(target) = target.filter(|value| accepts_target(value)) else {
            return;
        };
        let Some(recovery) = recovery_url(&target) else {
            return;
        };
        let _: () = msg_send![webview, stopLoading];
        let _ = navigate(webview, recovery.as_str());
    }

    unsafe fn navigate(webview: &AnyObject, target: &str) -> Result<(), String> {
        let target = NSString::from_str(target);
        let url =
            NSURL::URLWithString(&target).ok_or_else(|| "invalid navigation URL".to_string())?;
        let request = NSURLRequest::requestWithURL(&url);
        let _: *mut AnyObject = msg_send![webview, loadRequest: &*request];
        Ok(())
    }
}

#[cfg(target_os = "android")]
mod platform {
    pub fn attach(_platform: tauri::webview::PlatformWebview) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{cell::RefCell, rc::Rc};

    use webkit2gtk::{glib, NetworkError, WebView, WebViewExt};

    use super::recovery_url;

    pub fn attach(platform: tauri::webview::PlatformWebview) -> Result<(), String> {
        let webview = platform.inner();
        let tls_owner = Rc::new(RefCell::new(None::<String>));
        let generic_tls_owner = Rc::clone(&tls_owner);
        webview.connect_load_failed(move |webview, _event, failing_uri, error| {
            if generic_tls_owner.borrow().as_deref() == Some(failing_uri) {
                generic_tls_owner.borrow_mut().take();
                return true;
            }
            if !error.matches(NetworkError::Failed) && !error.matches(NetworkError::Transport) {
                return false;
            }
            show_recovery(webview, failing_uri)
        });

        webview.connect_load_failed_with_tls_errors(move |webview, failing_uri, _, _| {
            if !show_recovery(webview, failing_uri) {
                return false;
            }
            tls_owner.replace(Some(failing_uri.to_string()));
            let pending = Rc::downgrade(&tls_owner);
            glib::idle_add_local_once(move || {
                if let Some(pending) = pending.upgrade() {
                    pending.borrow_mut().take();
                }
            });
            true
        });

        Ok(())
    }

    fn show_recovery(webview: &WebView, target: &str) -> bool {
        let Some(recovery) = recovery_url(target) else {
            return false;
        };
        webview.stop_loading();
        webview.load_uri(recovery.as_str());
        true
    }
}

#[cfg(windows)]
mod platform {
    use webview2_com::{
        CoTaskMemPWSTR,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2, COREWEBVIEW2_WEB_ERROR_STATUS},
        NavigationCompletedEventHandler,
    };
    use windows::core::{BOOL, PWSTR};

    use super::{recovery_url, windows_recovers};

    pub fn attach(platform: tauri::webview::PlatformWebview) -> Result<(), String> {
        let webview =
            unsafe { platform.controller().CoreWebView2() }.map_err(|error| error.to_string())?;
        let settings = unsafe { webview.Settings() }.map_err(|error| error.to_string())?;
        unsafe { settings.SetIsBuiltInErrorPageEnabled(false) }
            .map_err(|error| error.to_string())?;

        let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let mut success = BOOL(0);
            unsafe { args.IsSuccess(&mut success) }?;
            if success.0 != 0 {
                return Ok(());
            }
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            unsafe { args.WebErrorStatus(&mut status) }?;
            if !windows_recovers(status.0) {
                return Ok(());
            }
            let mut source = PWSTR::null();
            unsafe { sender.Source(&mut source) }?;
            let target = webview2_com::take_pwstr(source);
            if let Some(recovery) = recovery_url(&target) {
                navigate(&sender, recovery.as_str())?;
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe { webview.add_NavigationCompleted(&handler, &mut token) }
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    fn navigate(webview: &ICoreWebView2, target: &str) -> windows::core::Result<()> {
        let target = CoTaskMemPWSTR::from(target);
        unsafe { webview.Navigate(*target.as_ref().as_pcwstr())? };
        Ok(())
    }
}

fn recovery_html() -> &'static str {
    r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Alook</title>
  <style>
    :root{color-scheme:light dark;--background:oklch(1 0 0);--foreground:oklch(0.18 0.03 230);--muted-foreground:oklch(0.44 0.03 230);--ring:oklch(0.55 0.03 230);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--background);color:var(--foreground)}
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;background:var(--background)}
    main{width:100%;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));text-align:center;cursor:pointer;outline:none;-webkit-user-select:none;user-select:none}
    main:focus-visible{outline:3px solid var(--ring);outline-offset:-4px}
    svg{width:48px;height:48px;color:var(--foreground)}
    p{margin:0;color:var(--muted-foreground);font-size:16px;line-height:1.55}
    main[aria-disabled="true"]{cursor:wait}
    main[aria-disabled="true"] svg{opacity:.55}
    @media(prefers-color-scheme:dark){:root{--background:oklch(0.16 0.008 60);--foreground:oklch(0.93 0.006 80);--muted-foreground:oklch(0.65 0.01 70);--ring:oklch(0.55 0.01 60)}}
  </style>
</head>
<body>
  <main data-testid="webview-recovery" role="button" tabindex="0" aria-label="Refresh">
    <svg data-testid="recovery-refresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
    <p data-testid="recovery-message" role="status" aria-live="polite">Network connection failed. Click to refresh</p>
  </main>
  <script>
    const params=new URLSearchParams(location.hash.slice(1));
    const candidate=params.get("target")||"";
    const surface=document.querySelector('[data-testid="webview-recovery"]');
    const message=document.querySelector('[data-testid="recovery-message"]');
    let target="";
    let retrying=false;
    try{const parsed=new URL(candidate);if((parsed.protocol==="http:"||parsed.protocol==="https:")&&parsed.hostname!=="alook-recovery.localhost")target=candidate}catch(_error){}
    if(!target)surface.setAttribute("aria-disabled","true");
    const refresh=()=>{if(retrying||!target)return;retrying=true;surface.setAttribute("aria-disabled","true");message.textContent="Retrying…";location.replace(target)};
    surface.addEventListener("click",refresh);
    surface.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();refresh()}});
    surface.focus();
    if(window.__TAURI_INTERNALS__)window.__TAURI_INTERNALS__.invoke("close_splashscreen").catch(()=>{});
  </script>
</body>
</html>"##
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    fn assert_order(source: &str, parts: &[&str]) {
        let mut offset = 0;
        for part in parts {
            let position = source[offset..]
                .find(part)
                .unwrap_or_else(|| panic!("missing source contract: {part}"));
            offset += position + part.len();
        }
    }

    fn wry_android_client_source() -> String {
        let cargo_home = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")))
            .expect("Cargo home must be available");
        for registry in fs::read_dir(cargo_home.join("registry/src")).unwrap() {
            let candidate = registry
                .unwrap()
                .path()
                .join("wry-0.55.1/src/android/kotlin/RustWebViewClient.kt");
            if candidate.is_file() {
                return fs::read_to_string(candidate).unwrap();
            }
        }
        panic!("locked Wry 0.55.1 source not found")
    }

    #[test]
    fn exact_http_targets_round_trip_through_both_protocol_transports() {
        let targets = [
            "https://alook.ai/c",
            "https://alook.ai/c/channel?after=%23一&view=all#message-7",
            "http://127.0.0.1:4317/path?a=hello%20world#end",
        ];
        for target in targets {
            for http_transport in [false, true] {
                let recovery = recovery_url_for(target, http_transport).unwrap();
                assert!(recovery.query().is_none());
                let restored =
                    url::form_urlencoded::parse(recovery.fragment().unwrap_or_default().as_bytes())
                        .find_map(|(key, value)| (key == "target").then(|| value.into_owned()));
                assert_eq!(restored.as_deref(), Some(target));
            }
        }
    }

    #[test]
    fn non_network_and_recovery_targets_are_rejected() {
        for target in [
            "",
            "not a url",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///tmp/page.html",
            "alook-recovery://localhost/network-error?target=https://alook.ai/c",
            "http://alook-recovery.localhost/network-error?target=https://alook.ai/c",
            "https://alook-recovery.localhost/network-error?target=https://alook.ai/c",
        ] {
            assert!(!accepts_target(target), "accepted {target}");
            assert!(recovery_url_for(target, false).is_none());
        }
    }

    #[test]
    fn platform_error_allowlists_exclude_control_flow_and_auth_failures() {
        for code in [-2, -6, -7, -8, -11] {
            assert!(android_recovers(code));
        }
        for code in [-1, -3, -4, -5, -9, -10, -12, -13, -14, -15, -16] {
            assert!(!android_recovers(code));
        }

        for code in [
            -1001, -1003, -1004, -1005, -1006, -1009, -1200, -1201, -1202, -1203, -1204, -1205,
            -1206, -2000,
        ] {
            assert!(apple_recovers(code));
        }
        for code in [-999, -1012, -1013, -1015, -1016, -1017] {
            assert!(!apple_recovers(code));
        }

        for code in [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13] {
            assert!(windows_recovers(code));
        }
        for code in [0, 8, 14, 15, 16, 17, 18] {
            assert!(!windows_recovers(code));
        }
    }

    #[test]
    fn recovery_document_has_stable_test_seams_and_only_explicit_retry() {
        let html = recovery_html();
        for test_id in [
            "webview-recovery",
            "recovery-refresh-icon",
            "recovery-message",
        ] {
            assert!(html.contains(&format!("data-testid=\"{test_id}\"")));
        }
        assert!(html.contains("if(retrying||!target)return"));
        assert!(html.contains("location.replace(target)"));
        assert!(html.contains("event.key===\"Enter\"||event.key===\" \""));
        assert!(html.contains("color:var(--foreground)"));
        assert!(html.contains("outline:3px solid var(--ring)"));
        assert!(html.contains("Network connection failed. Click to refresh"));
        assert!(html.contains("message.textContent=\"Retrying…\""));
        assert!(!html.contains("textContent=target"));
        assert!(!html.contains("location.reload"));
        assert!(!html.contains("setTimeout"));
        assert!(!html.contains("addEventListener(\"online\""));
        assert!(!html.contains("transition:"));
        assert!(!html.contains("linear-gradient"));
        assert!(!html.contains("box-shadow"));
        assert!(!html.contains("#e66b2e"));
        assert!(!html
            .chars()
            .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character)));
        assert!(html.contains("parsed.hostname!==\"alook-recovery.localhost\""));
    }

    #[test]
    fn protocol_response_is_private_html() {
        let request = Request::builder()
            .uri("alook-recovery://localhost/network-error")
            .body(Vec::new())
            .unwrap();
        let response = response(request);
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
        );
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        for directive in [
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive));
        }
        assert!(!csp.contains("navigate-to"));
        assert!(String::from_utf8(response.body().clone())
            .unwrap()
            .contains("Network connection failed. Click to refresh"));
    }

    #[test]
    fn bootstrap_is_blank_and_unknown_paths_fail_closed() {
        let request = Request::builder()
            .uri("alook-recovery://localhost/bootstrap")
            .body(Vec::new())
            .unwrap();
        let bootstrap_response = response(request);
        let html = String::from_utf8(bootstrap_response.body().clone()).unwrap();
        assert_eq!(bootstrap_response.status(), 200);
        assert_eq!(
            bootstrap_response.headers()["content-security-policy"],
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        );
        assert_eq!(
            bootstrap_response.headers()["x-content-type-options"],
            "nosniff"
        );
        assert_eq!(
            bootstrap_response.headers()["referrer-policy"],
            "no-referrer"
        );
        assert!(!html.contains("<script"));
        assert!(!html.contains("network-error"));

        let request = Request::builder()
            .uri("alook-recovery://localhost/unknown")
            .body(Vec::new())
            .unwrap();
        let response = response(request);
        assert_eq!(response.status(), 404);
        assert!(response.body().is_empty());
    }

    #[test]
    fn bootstrap_detection_accepts_native_and_mapped_transports() {
        for target in [
            "alook-recovery://localhost/bootstrap",
            "http://alook-recovery.localhost/bootstrap",
        ] {
            assert!(is_bootstrap_url(&Url::parse(target).unwrap()));
        }
        assert!(!is_bootstrap_url(
            &Url::parse("alook-recovery://localhost/network-error").unwrap()
        ));
    }

    #[test]
    fn invalid_fragment_fails_closed() {
        let html = recovery_html();
        assert!(html.contains("if(!target)surface.setAttribute(\"aria-disabled\",\"true\")"));
        assert!(html.contains("if(retrying||!target)return"));
        assert!(!html.contains("if(!target)target="));
    }

    #[test]
    fn build_configuration_bootstraps_only_production() {
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains("\"devUrl\": \"http://localhost:3000/c\""));
        assert!(config.contains("\"frontendDist\": \"alook-recovery://localhost/bootstrap\""));

        let lib = include_str!("lib.rs");
        assert_order(
            lib,
            &[
                "webview_recovery::register_protocol(tauri::Builder::default())",
                "run_desktop(builder)",
                "fn run_app(builder:",
                ".build(tauri::generate_context!())",
            ],
        );
        assert_eq!(lib.matches("webview_recovery::attach(&window);").count(), 2);
        assert_eq!(
            lib.matches("webview_recovery::on_page_load(webview, payload);")
                .count(),
            2
        );
        assert!(!lib.contains("on_webview_ready"));
    }

    #[test]
    fn native_source_installs_hooks_before_finished_bootstrap_navigation() {
        let source = include_str!("webview_recovery.rs");
        assert_order(
            source,
            &[
                "objc_setAssociatedObject(",
                "add_failure_method(",
                "setNavigationDelegate: delegate",
            ],
        );
        assert_order(
            source,
            &[
                "connect_load_failed(move",
                "connect_load_failed_with_tls_errors(move",
            ],
        );
        assert_order(
            source,
            &[
                "SetIsBuiltInErrorPageEnabled(false)",
                "add_NavigationCompleted(&handler",
            ],
        );
        assert!(source.contains("tauri::webview::PageLoadEvent::Finished"));
        assert!(source.contains("is_bootstrap_url(payload.url())"));
        assert_order(
            source,
            &[
                "self.hooks_ready.load(Ordering::Acquire)",
                "self.bootstrap_finished.load(Ordering::Acquire)",
                "self.navigation_started.swap(true, Ordering::AcqRel)",
            ],
        );
        assert!(source.contains("STARTUP.signal_hooks_ready()"));
        assert!(source.contains("STARTUP.signal_bootstrap_finished()"));
        assert!(source.contains("navigate_window_to_production(&startup_window)"));
        assert!(source.contains("navigate_webview_to_production(webview)"));
        let initial_navigation = ["Url::parse(", "PRODUCTION_TARGET)"].concat();
        assert_eq!(source.matches(&initial_navigation).count(), 1);
        assert!(!source.contains(&["window", ".url()"].concat()));
    }

    #[test]
    fn ready_then_finished_starts_once() {
        let startup = StartupRendezvous::new();
        assert!(!startup.signal_hooks_ready());
        assert!(startup.signal_bootstrap_finished());
    }

    #[test]
    fn finished_then_ready_starts_once() {
        let startup = StartupRendezvous::new();
        assert!(!startup.signal_bootstrap_finished());
        assert!(startup.signal_hooks_ready());
    }

    #[test]
    fn duplicate_startup_signals_never_restart() {
        let startup = StartupRendezvous::new();
        assert!(!startup.signal_hooks_ready());
        assert!(startup.signal_bootstrap_finished());
        assert!(!startup.signal_hooks_ready());
        assert!(!startup.signal_bootstrap_finished());
    }

    #[test]
    fn missing_hook_readiness_fails_closed() {
        let startup = StartupRendezvous::new();
        assert!(!startup.signal_bootstrap_finished());
        assert!(!startup.signal_bootstrap_finished());
        assert!(!startup.navigation_started.load(Ordering::Acquire));
    }

    #[test]
    fn android_extension_preserves_wry_client_and_cancels_ssl() {
        let extension = include_str!("../.cargo/config.toml");
        assert!(extension.contains("WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION"));
        assert!(extension.contains("override fun onReceivedError("));
        assert!(extension
            .contains("WebviewRecovery.handleError(view, errorCode, currentUrl, failingUrl)"));
        assert_order(
            extension,
            &[
                "override fun onReceivedSslError(",
                "handler.cancel()",
                "WebviewRecovery.handleSslError(view, currentUrl, error.url)",
            ],
        );
        assert!(!extension.contains("setWebViewClient"));

        let helper =
            include_str!("../gen/android/app/src/main/java/ai/alook/android/WebviewRecovery.kt");
        assert!(helper.contains("documentIdentity(currentUrl) != documentIdentity(failingUrl)"));
        assert!(helper.contains("return recoveryUrl(currentUrl)"));

        let lock = include_str!("../Cargo.lock");
        assert!(lock.contains("name = \"wry\"\nversion = \"0.55.1\""));
        let wry = wry_android_client_source();
        assert!(wry.contains("request: WebResourceRequest"));
        assert!(wry.contains("request.isForMainFrame"));
        assert!(wry.contains("super.onReceivedError(view, request, error)"));
    }
}
