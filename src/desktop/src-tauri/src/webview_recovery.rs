use std::sync::atomic::{AtomicBool, Ordering};
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;
use url::Url;

pub const SCHEME: &str = "alook-recovery";
const HOST: &str = "alook-recovery.localhost";
const BOOTSTRAP_PATH: &str = "/bootstrap";
const RECOVERY_PATH: &str = "/network-error";
const PRODUCTION_TARGET: &str = "https://alook.ai/c";
const SPLASH_BACKGROUND_LIGHT: &str = "#fff";
const SPLASH_BACKGROUND_DARK: &str = "#100d0a";
static STARTUP: StartupRendezvous = StartupRendezvous::new();

struct StartupRendezvous {
    hooks_ready: AtomicBool,
    bootstrap_finished: AtomicBool,
    navigation_started: AtomicBool,
    abandoned: AtomicBool,
}

impl StartupRendezvous {
    const fn new() -> Self {
        Self {
            hooks_ready: AtomicBool::new(false),
            bootstrap_finished: AtomicBool::new(false),
            navigation_started: AtomicBool::new(false),
            abandoned: AtomicBool::new(false),
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
        !self.abandoned.load(Ordering::Acquire)
            && self.hooks_ready.load(Ordering::Acquire)
            && self.bootstrap_finished.load(Ordering::Acquire)
            && !self.navigation_started.swap(true, Ordering::AcqRel)
    }

    fn signal_failure(&self) -> bool {
        !self.abandoned.swap(true, Ordering::AcqRel)
    }

    fn abandon(&self) {
        self.abandoned.store(true, Ordering::Release);
    }
}

pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .register_uri_scheme_protocol(SCHEME, |_context, request| response(request))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("main-navigation-boundary")
                .on_navigation(|webview, url| {
                    webview.label() != "main" || navigation_allowed(url, tauri::is_dev())
                })
                .build(),
        )
}

fn navigation_allowed(url: &Url, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let production = url.scheme() == "https"
        && url.host_str() == Some("alook.ai")
        && url.port_or_known_default() == Some(443);
    let recovery = url.query().is_none()
        && matches!(url.path(), BOOTSTRAP_PATH | RECOVERY_PATH)
        && ((url.scheme() == SCHEME
            && url.host_str() == Some("localhost")
            && url.port().is_none())
            || (url.scheme() == "http"
                && url.host_str() == Some(HOST)
                && url.port_or_known_default() == Some(80)));
    let local_development = development
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(3000);

    production || recovery || local_development
}

fn response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let (status, csp, body) = match request.uri().path() {
        BOOTSTRAP_PATH => (
            StatusCode::OK,
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            bootstrap_html().into_bytes(),
        ),
        RECOVERY_PATH => (
            StatusCode::OK,
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            recovery_html().as_bytes().to_vec(),
        ),
        _ => (
            StatusCode::NOT_FOUND,
            "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            Vec::new(),
        ),
    };
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", csp)
        .body(body)
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

#[cfg(any(desktop, target_os = "ios"))]
pub fn finish_native_creation(window: &tauri::WebviewWindow) {
    let ready_window = window.clone();
    let error_window = window.clone();
    if let Err(error) = window.with_webview(move |platform| {
        #[cfg(desktop)]
        {
            let _ = platform;
            if !crate::commands::finish_native_startup(ready_window.app_handle()) {
                eprintln!("native WebView startup handoff unavailable");
            }
        }
        #[cfg(target_os = "ios")]
        unsafe {
            use objc2::{msg_send, runtime::AnyObject, sel};

            let _ = ready_window;
            let controller = platform.view_controller().cast::<AnyObject>();
            let webview = platform.inner().cast::<AnyObject>();
            let completed = if controller.is_null() || webview.is_null() {
                false
            } else if let Some(class) = apple_class_method(
                c"UIViewController",
                sel!(alook_finishStartupOverlayForController:webView:),
            ) {
                msg_send![class, alook_finishStartupOverlayForController: controller, webView: webview]
            } else {
                false
            };
            if !completed {
                eprintln!("native WebView startup handoff unavailable");
                show_native_creation_error();
            }
        }
    }) {
        eprintln!("native WebView startup callback unavailable: {error}");
        #[cfg(target_os = "macos")]
        crate::commands::show_startup_initialization_error(error_window.app_handle());
        #[cfg(target_os = "ios")]
        if let Err(error) = error_window.run_on_main_thread(show_native_creation_error) {
            eprintln!("native WebView error dispatch unavailable: {error}");
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let _ = error_window;
    }
}

#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
fn apple_class_method(
    name: &std::ffi::CStr,
    selector: objc2::runtime::Sel,
) -> Option<&'static objc2::runtime::AnyClass> {
    objc2::runtime::AnyClass::get(name).filter(|class| class.metaclass().responds_to(selector))
}

#[cfg(target_os = "ios")]
fn show_native_creation_error() {
    use objc2::{msg_send, sel};

    if let Some(class) = apple_class_method(
        c"UIViewController",
        sel!(alook_showStartupInitializationError),
    ) {
        let _: () = unsafe { msg_send![class, alook_showStartupInitializationError] };
    } else {
        eprintln!("native WebView initialization error bridge unavailable");
    }
}

pub fn attach(window: &tauri::WebviewWindow) {
    let startup_window = window.clone();
    let error_window = window.clone();
    if let Err(error) = window.with_webview(move |webview| match platform::attach(webview) {
        Ok(()) => {
            if STARTUP.signal_hooks_ready() {
                replace_window_with_initial_target(&startup_window);
            }
        }
        Err(error) => {
            eprintln!("webview recovery unavailable: {error}");
            initialization_failure(&startup_window);
        }
    }) {
        eprintln!("webview recovery callback unavailable: {error}");
        initialization_failure(&error_window);
    }
}

pub fn on_page_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if webview.label() == "main"
        && is_recovery_url(payload.url())
        && payload.url().path() == RECOVERY_PATH
    {
        STARTUP.abandon();
    }
    if webview.label() != "main"
        || !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
        || !is_bootstrap_url(payload.url())
    {
        return;
    }
    if STARTUP.signal_bootstrap_finished() {
        replace_webview_with_initial_target(webview);
    }
}

fn initial_replace_script(
    development: bool,
    development_url: Option<&Url>,
) -> Result<String, &'static str> {
    let target = if development {
        let root = development_url
            .filter(|url| url.as_str() == "http://localhost:3000/")
            .ok_or("untrusted_development_root")?;
        root.join("c")
            .expect("validated development root must accept the main route")
            .to_string()
    } else {
        PRODUCTION_TARGET.to_string()
    };
    let target =
        serde_json::to_string(&target).expect("initial target must serialize as JavaScript string");
    Ok(format!("location.replace({target})"))
}

fn replace_window_with_initial_target(window: &tauri::WebviewWindow) {
    let result = initial_replace_script(tauri::is_dev(), window.config().build.dev_url.as_ref())
        .map_err(str::to_owned)
        .and_then(|script| window.eval(script).map_err(|error| error.to_string()));
    if let Err(error) = result {
        eprintln!("webview recovery initial navigation unavailable: {error}");
        initialization_failure(window);
    }
}

fn replace_webview_with_initial_target<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let result = initial_replace_script(tauri::is_dev(), webview.config().build.dev_url.as_ref())
        .map_err(str::to_owned)
        .and_then(|script| webview.eval(script).map_err(|error| error.to_string()));
    if let Err(error) = result {
        eprintln!("webview recovery initial navigation unavailable: {error}");
        if STARTUP.signal_failure() {
            if let Err(error) = webview.navigate(initialization_error_url()) {
                eprintln!("webview initialization error navigation unavailable: {error}");
            }
        }
    }
}

fn initialization_error_url() -> Url {
    #[cfg(any(windows, target_os = "android"))]
    let base = format!("http://{HOST}{RECOVERY_PATH}#reason=initialization");
    #[cfg(not(any(windows, target_os = "android")))]
    let base = format!("{SCHEME}://localhost{RECOVERY_PATH}#reason=initialization");
    Url::parse(&base).unwrap()
}

fn initialization_failure(window: &tauri::WebviewWindow) {
    if STARTUP.signal_failure() {
        if let Err(error) = window.navigate(initialization_error_url()) {
            eprintln!("webview initialization error navigation unavailable: {error}");
        }
    }
}

fn bootstrap_html() -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Alook</title><style>:root{{color-scheme:light dark;--background:{light}}}html,body{{width:100%;height:100%;margin:0;overflow:hidden;background:var(--background)}}@media(prefers-color-scheme:dark){{:root{{--background:{dark}}}}}</style></head><body></body></html>"#,
        light = SPLASH_BACKGROUND_LIGHT,
        dark = SPLASH_BACKGROUND_DARK,
    )
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use std::{
        ffi::c_void,
        panic::AssertUnwindSafe,
        sync::{
            atomic::{AtomicBool, Ordering},
            OnceLock,
        },
    };

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
    struct Hooks {
        class: usize,
        originals: [Option<Imp>; 2],
        installed: AtomicBool,
    }
    static HOOKS: OnceLock<Hooks> = OnceLock::new();

    pub fn attach(platform: tauri::webview::PlatformWebview) -> Result<(), String> {
        let webview = unsafe { webview_object(platform.inner()) };
        let delegate: *mut AnyObject = unsafe { msg_send![webview, navigationDelegate] };
        let delegate = unsafe { delegate.as_ref() }
            .ok_or_else(|| "missing Wry navigation delegate".to_string())?;

        unsafe {
            #[cfg(target_os = "ios")]
            let _: () = msg_send![webview, setAllowsBackForwardNavigationGestures: false];
            objc_setAssociatedObject(
                webview as *const AnyObject as *mut AnyObject,
                marker_key(),
                webview as *const AnyObject as *mut AnyObject,
                OBJC_ASSOCIATION_ASSIGN,
            );
            install_hooks(delegate.class())?;
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

    unsafe fn install_hooks(class: &AnyClass) -> Result<(), String> {
        if let Some(hooks) = HOOKS.get() {
            return if hooks.class == class as *const AnyClass as usize
                && hooks.installed.load(Ordering::Acquire)
            {
                Ok(())
            } else {
                Err("Wry recovery hook installation unavailable".into())
            };
        }
        let selectors = [
            sel!(webView:didFailProvisionalNavigation:withError:),
            sel!(webView:didFailNavigation:withError:),
        ];
        let originals =
            selectors.map(|selector| class.instance_method(selector).map(|m| m.implementation()));
        HOOKS
            .set(Hooks {
                class: class as *const AnyClass as usize,
                originals,
                installed: AtomicBool::new(false),
            })
            .map_err(|_| "Wry recovery hooks already recorded".to_string())?;
        let implementations: [Imp; 2] = [
            std::mem::transmute(
                did_fail_provisional
                    as unsafe extern "C-unwind" fn(
                        &AnyObject,
                        Sel,
                        &AnyObject,
                        *mut AnyObject,
                        &NSError,
                    ),
            ),
            std::mem::transmute(
                did_fail
                    as unsafe extern "C-unwind" fn(
                        &AnyObject,
                        Sel,
                        &AnyObject,
                        *mut AnyObject,
                        &NSError,
                    ),
            ),
        ];
        let hooks = HOOKS.get().unwrap();
        install_hook_sequence(
            &hooks.installed,
            |index| {
                if let Some(method) = class.instance_method(selectors[index]) {
                    method.set_implementation(implementations[index]);
                    true
                } else {
                    bool::from(class_addMethod(
                        class as *const AnyClass as *mut AnyClass,
                        selectors[index],
                        implementations[index],
                        b"v@:@@@\0".as_ptr().cast(),
                    ))
                }
            },
            || {
                selectors
                    .iter()
                    .zip(implementations)
                    .all(|(selector, implementation)| {
                        class.instance_method(*selector).is_some_and(|m| {
                            m.implementation() as *const () == implementation as *const ()
                        })
                    })
            },
            || {
                for (selector, original) in selectors.iter().zip(hooks.originals) {
                    if let Some(original) = original {
                        if let Some(method) = class.instance_method(*selector) {
                            method.set_implementation(original);
                        }
                    }
                }
            },
        )
    }

    fn install_hook_sequence(
        installed: &AtomicBool,
        mut install: impl FnMut(usize) -> bool,
        verify: impl FnOnce() -> bool,
        rollback: impl FnOnce(),
    ) -> Result<(), String> {
        for index in 0..2 {
            if !install(index) {
                rollback();
                return Err("failed to install WebKit recovery hook".into());
            }
        }
        if !verify() {
            rollback();
            return Err("WebKit recovery hook verification failed".into());
        }
        installed.store(true, Ordering::Release);
        Ok(())
    }

    unsafe fn failure(
        index: usize,
        delegate: &AnyObject,
        selector: Sel,
        webview: &AnyObject,
        navigation: *mut AnyObject,
        error: &NSError,
    ) {
        if let Some(original) = HOOKS.get().and_then(|hooks| hooks.originals[index]) {
            let callback: unsafe extern "C-unwind" fn(
                &AnyObject,
                Sel,
                &AnyObject,
                *mut AnyObject,
                &NSError,
            ) = std::mem::transmute(original);
            callback(delegate, selector, webview, navigation, error);
        }
        if !HOOKS
            .get()
            .is_some_and(|hooks| hooks.installed.load(Ordering::Acquire))
        {
            return;
        }
        handle_failure(webview, error);
    }

    unsafe extern "C-unwind" fn did_fail_provisional(
        delegate: &AnyObject,
        selector: Sel,
        webview: &AnyObject,
        navigation: *mut AnyObject,
        error: &NSError,
    ) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| unsafe {
            failure(0, delegate, selector, webview, navigation, error)
        }));
    }
    unsafe extern "C-unwind" fn did_fail(
        delegate: &AnyObject,
        selector: Sel,
        webview: &AnyObject,
        navigation: *mut AnyObject,
        error: &NSError,
    ) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| unsafe {
            failure(1, delegate, selector, webview, navigation, error)
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
    #[cfg(test)]
    mod hook_tests {
        use super::*;
        use std::cell::RefCell;

        #[test]
        fn hook_completion_is_published_only_after_all_installs_and_verification() {
            let installed = AtomicBool::new(false);
            let steps = RefCell::new(Vec::new());
            assert!(install_hook_sequence(
                &installed,
                |index| {
                    assert!(!installed.load(Ordering::Acquire));
                    steps.borrow_mut().push(index);
                    true
                },
                || {
                    assert!(!installed.load(Ordering::Acquire));
                    assert_eq!(*steps.borrow(), vec![0, 1]);
                    true
                },
                || panic!("successful installation must not roll back"),
            )
            .is_ok());
            assert!(installed.load(Ordering::Acquire));
        }

        #[test]
        fn every_partial_install_failure_rolls_back_without_publishing_completion() {
            for failure in 0..2 {
                let installed = AtomicBool::new(false);
                let methods = RefCell::new([false; 2]);
                let rolled_back = AtomicBool::new(false);
                assert!(install_hook_sequence(
                    &installed,
                    |index| {
                        assert!(!installed.load(Ordering::Acquire));
                        if index == failure {
                            return false;
                        }
                        methods.borrow_mut()[index] = true;
                        true
                    },
                    || panic!("partial installation must not verify"),
                    || {
                        assert!(!installed.load(Ordering::Acquire));
                        *methods.borrow_mut() = [false; 2];
                        rolled_back.store(true, Ordering::Release);
                    },
                )
                .is_err());
                assert!(!installed.load(Ordering::Acquire));
                assert!(rolled_back.load(Ordering::Acquire));
                assert_eq!(*methods.borrow(), [false; 2]);
            }
        }

        #[test]
        fn unexpected_installed_imp_rolls_back_and_keeps_completion_false() {
            let installed = AtomicBool::new(false);
            let rolled_back = AtomicBool::new(false);
            assert!(install_hook_sequence(
                &installed,
                |_| true,
                || false,
                || rolled_back.store(true, Ordering::Release),
            )
            .is_err());
            assert!(!installed.load(Ordering::Acquire));
            assert!(rolled_back.load(Ordering::Acquire));
        }
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
    main:focus-visible svg{outline:3px solid var(--ring);outline-offset:4px;border-radius:50%}
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
    if(params.get("reason")==="initialization")message.textContent="App initialization failed. Close and reopen Alook";
    const originalMessage=message.textContent;
    let target="";
    let retrying=false;
    let blurred=false;
    let hidden=document.hidden;
    try{const parsed=new URL(candidate);if((parsed.protocol==="http:"||parsed.protocol==="https:")&&parsed.hostname!=="alook-recovery.localhost")target=candidate}catch(_error){}
    if(params.get("reason")==="initialization")target="";
    if(!target)surface.setAttribute("aria-disabled","true");
    const refresh=()=>{if(retrying||!target)return;retrying=true;surface.setAttribute("aria-disabled","true");message.textContent="Retrying…";try{location.replace(target)}catch(_error){retrying=false;surface.setAttribute("aria-disabled","false");message.textContent=originalMessage}};
    const onKeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();refresh()}};
    const onBlur=()=>{blurred=true};
    const onFocus=()=>{if(!blurred)return;blurred=false;refresh()};
    const onVisibilityChange=()=>{if(document.hidden){hidden=true;return}if(!hidden)return;hidden=false;refresh()};
    const listeners=[];
    const listen=(owner,type,handler)=>{owner.addEventListener(type,handler);listeners.push([owner,type,handler])};
    const cleanup=()=>{while(listeners.length){const [owner,type,handler]=listeners.pop();owner.removeEventListener(type,handler)}};
    listen(surface,"click",refresh);
    listen(surface,"keydown",onKeydown);
    listen(window,"online",refresh);
    listen(window,"blur",onBlur);
    listen(window,"focus",onFocus);
    listen(document,"visibilitychange",onVisibilityChange);
    listen(window,"pagehide",cleanup);
  </script>
</body>
</html>"##
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_class_method_finds_registered_class_selector() {
        assert!(apple_class_method(c"NSString", objc2::sel!(string)).is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_class_method_rejects_missing_class_and_selector() {
        assert!(
            apple_class_method(c"AlookMissingStartupBridgeClass", objc2::sel!(string)).is_none()
        );
        assert!(
            apple_class_method(c"NSString", objc2::sel!(alookMissingStartupSelector)).is_none()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_class_method_rejects_instance_only_selector() {
        let class = objc2::runtime::AnyClass::get(c"NSString").unwrap();
        assert!(class.responds_to(objc2::sel!(length)));
        assert!(apple_class_method(c"NSString", objc2::sel!(length)).is_none());
    }

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
                .join("wry-0.57.0/src/android/kotlin/RustWebViewClient.kt");
            if candidate.is_file() {
                return fs::read_to_string(candidate).unwrap();
            }
        }
        panic!("locked Wry 0.57.0 source not found")
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
    fn recovery_document_has_stable_test_seams_and_lifecycle_retry() {
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
        assert!(html.contains("main:focus-visible svg{outline:3px solid var(--ring)"));
        assert!(html.contains("Network connection failed. Click to refresh"));
        assert!(html.contains("message.textContent=\"Retrying…\""));
        assert!(!html.contains("textContent=target"));
        assert!(!html.contains("autofocus"));
        assert!(!html.contains("surface.focus()"));
        assert!(!html.contains("location.reload"));
        assert!(!html.contains("setTimeout"));
        assert!(!html.contains("setInterval"));
        for lifecycle_event in ["online", "blur", "focus", "visibilitychange", "pagehide"] {
            assert!(
                html.contains(&format!("listen(window,\"{lifecycle_event}\""))
                    || html.contains(&format!("listen(document,\"{lifecycle_event}\""))
            );
        }
        assert!(html.contains("removeEventListener(type,handler)"));
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
    fn bootstrap_is_static_and_unknown_paths_fail_closed() {
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
    fn bootstrap_is_theme_background_without_another_startup_logo() {
        let html = bootstrap_html();
        assert!(html.contains("--background:#fff"));
        assert!(html.contains("--background:#100d0a"));
        assert!(html.contains("<body></body>"));
        assert!(!html.contains("<img"));
        assert!(!html.contains("data:image"));
        assert!(!html.contains("--alook-mobile-splash-offset-y"));
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
    fn main_navigation_policy_is_fail_closed() {
        for target in [
            "https://alook.ai/",
            "https://alook.ai/c/channel?after=1#message-2",
            "https://alook.ai:443/c",
            "alook-recovery://localhost/bootstrap",
            "alook-recovery://localhost/network-error#target=https%3A%2F%2Falook.ai%2Fc",
            "http://alook-recovery.localhost/network-error#target=https%3A%2F%2Falook.ai%2Fc",
        ] {
            assert!(
                navigation_allowed(&Url::parse(target).unwrap(), false),
                "rejected {target}"
            );
        }

        for target in [
            "http://alook.ai/c",
            "https://alook.ai.evil.test/c",
            "https://user@alook.ai/c",
            "https://alook.ai:444/c",
            "javascript:alert(1)",
            "about:blank",
            "alook-recovery://evil.test/bootstrap",
            "alook-recovery://localhost/unknown",
            "alook-recovery://localhost/bootstrap?spoof=1",
            "https://alook-recovery.localhost/network-error",
            "http://localhost:3000/c",
        ] {
            assert!(
                !navigation_allowed(&Url::parse(target).unwrap(), false),
                "accepted {target}"
            );
        }

        assert!(navigation_allowed(
            &Url::parse("http://localhost:3000/c").unwrap(),
            true,
        ));
        assert!(!navigation_allowed(
            &Url::parse("http://127.0.0.1:3000/c").unwrap(),
            true,
        ));
    }

    #[test]
    fn initial_navigation_selects_only_the_original_development_root() {
        let root = Url::parse("http://localhost:3000").unwrap();
        assert_eq!(
            initial_replace_script(true, Some(&root)),
            Ok(r#"location.replace("http://localhost:3000/c")"#.to_string())
        );
        assert_eq!(
            initial_replace_script(false, None),
            Ok(r#"location.replace("https://alook.ai/c")"#.to_string())
        );
        assert_eq!(
            initial_replace_script(false, Some(&root)),
            initial_replace_script(false, None)
        );
        assert_eq!(
            initial_replace_script(true, None),
            Err("untrusted_development_root")
        );
        for target in [
            "http://localhost:3000/c",
            "http://localhost:3000/?source=other",
            "http://localhost:3000/#fragment",
            "http://user@localhost:3000/",
            "http://user:password@localhost:3000/",
            "http://localhost:3001/",
            "http://127.0.0.1:3000/",
            "http://192.168.1.2:3000/",
            "https://localhost:3000/",
            "tauri://localhost/",
            "http://tauri.localhost/",
        ] {
            let target = Url::parse(target).unwrap();
            assert_eq!(
                initial_replace_script(true, Some(&target)),
                Err("untrusted_development_root"),
                "accepted {target}"
            );
            assert_eq!(
                initial_replace_script(false, Some(&target)),
                initial_replace_script(false, None)
            );
        }
    }

    #[test]
    fn development_config_keeps_the_local_bootstrap_and_http_upstream_separate() {
        use tauri::utils::{
            config::{parse::read_from, Config, WebviewUrl},
            platform::Target,
        };
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let (base, _) = read_from(Target::Android, &project).unwrap();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let fixture = Fixture(
            std::env::temp_dir().join(format!("alook-config199r4-{}-{nonce}", std::process::id())),
        );
        fs::create_dir(&fixture.0).unwrap();
        fs::write(
            fixture.0.join("tauri.conf.json"),
            serde_json::to_vec(&base).unwrap(),
        )
        .unwrap();
        fs::write(
            fixture.0.join("tauri.android.conf.json"),
            include_str!("../tauri.dev.conf.json"),
        )
        .unwrap();
        let (merged, _) = read_from(Target::Android, &fixture.0).unwrap();
        let mut window = merged["app"]["windows"][0].clone();
        assert_eq!(
            window.as_object_mut().unwrap().remove("url"),
            Some(serde_json::json!("alook-recovery://localhost/bootstrap"))
        );
        assert_eq!(window, base["app"]["windows"][0]);
        assert_eq!(merged["identifier"], base["identifier"]);
        assert_eq!(
            merged["app"]["security"]["capabilities"],
            serde_json::from_str::<serde_json::Value>(include_str!("../tauri.dev.conf.json"))
                .unwrap()["app"]["security"]["capabilities"]
        );
        fs::write(
            fixture.0.join("tauri.conf.json"),
            serde_json::to_vec(&merged).unwrap(),
        )
        .unwrap();
        fs::write(
            fixture.0.join("tauri.android.conf.json"),
            r#"{"bundle":{"android":{"debugApplicationIdSuffix":".qa.config199r4"}}}"#,
        )
        .unwrap();
        let (with_qa, _) = read_from(Target::Android, &fixture.0).unwrap();
        assert_eq!(with_qa["app"], merged["app"]);
        assert_eq!(
            with_qa["bundle"]["android"]["debugApplicationIdSuffix"],
            ".qa.config199r4"
        );
        let config: Config = serde_json::from_value(with_qa).unwrap();
        let upstream = config.build.dev_url.as_ref().unwrap();
        assert_eq!(upstream.as_str(), "http://localhost:3000/");
        assert_eq!(config.app.windows.len(), 1);
        match &config.app.windows[0].url {
            WebviewUrl::CustomProtocol(url) => {
                assert_eq!(url.as_str(), "alook-recovery://localhost/bootstrap")
            }
            other => panic!("unexpected main entry {other:?}"),
        }
        assert_eq!(
            initial_replace_script(true, Some(upstream)),
            Ok(r#"location.replace("http://localhost:3000/c")"#.to_string())
        );
        for path in [
            "c",
            "_next/static/chunk.js",
            "api/health",
            "api/auth/sign-in/email",
            "api/community/users/me/inbox",
        ] {
            assert_eq!(upstream.join(path).unwrap().path(), format!("/{path}"));
        }
    }

    #[test]
    fn invalid_fragment_fails_closed() {
        let html = recovery_html();
        assert!(html.contains("if(!target)surface.setAttribute(\"aria-disabled\",\"true\")"));
        assert!(html.contains("if(retrying||!target)return"));
        assert!(!html.contains("if(!target)target="));
    }

    #[test]
    fn build_configuration_preserves_production_bootstrap_and_target() {
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
    fn container_handoff_is_independent_of_page_and_recovery() {
        let lib = include_str!("lib.rs");
        assert_eq!(
            lib.matches("webview_recovery::finish_native_creation(&window);")
                .count(),
            2
        );
        let apple = include_str!("../gen/apple/Sources/alook-desktop/main.mm");
        assert!(apple.contains("[controller.view.subviews containsObject:webView]"));
        assert!(apple.contains("gAlookStartupCompleted = YES"));
        assert!(!apple.contains("takeSnapshot"));
        assert!(!apple.contains("document.readyState"));
        let activity =
            include_str!("../gen/android/app/src/main/java/ai/alook/android/MainActivity.kt");
        assert!(activity.contains("webView.addOnAttachStateChangeListener(listener)"));
        assert!(activity
            .contains("if (webView.isAttachedToWindow) listener.onViewAttachedToWindow(webView)"));
        assert!(activity.contains("view !== mainWebView || isDestroyed || isFinishing"));
        assert!(activity.contains("mainWebView?.removeOnAttachStateChangeListener(it)"));
        assert!(!activity.contains("postVisualStateCallback"));
        assert!(!activity.contains("postDelayed"));
        assert!(!activity.contains("StartupDocument"));
        let commands = include_str!("commands.rs");
        assert_order(
            commands,
            &[
                "if let Err(error) = main.show()",
                "if let Err(error) = splash.close()",
                "SPLASH_CLOSED.store(true",
            ],
        );
    }

    #[test]
    fn recovery_install_failure_and_bootstrap_finish_cannot_restart_production() {
        for finished_first in [false, true] {
            let startup = StartupRendezvous::new();
            if finished_first {
                assert!(!startup.signal_bootstrap_finished());
            }
            assert!(startup.signal_failure());
            assert!(!startup.signal_failure());
            assert!(!startup.signal_hooks_ready());
            assert!(!startup.signal_bootstrap_finished());
            assert!(!startup.navigation_started.load(Ordering::Acquire));
        }
        let startup = StartupRendezvous::new();
        assert!(!startup.signal_hooks_ready());
        assert!(startup.signal_bootstrap_finished());
        assert!(startup.signal_failure());
        assert!(!startup.signal_failure());
        assert!(!startup.signal_hooks_ready());
        assert!(!startup.signal_bootstrap_finished());
        assert!(
            recovery_html().contains("if(params.get(\"reason\")===\"initialization\")target=\"\"")
        );
        assert!(initialization_error_url()
            .as_str()
            .ends_with("#reason=initialization"));
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
    fn android_extension_preserves_network_and_wry_without_page_ready() {
        let extension = include_str!("../.cargo/config.toml");
        assert!(!extension.contains("onPageCommitVisible"));
        assert!(!extension.contains("setWebViewClient"));
        assert_order(
            extension,
            &[
                "override fun onReceivedSslError(",
                "handler.cancel()",
                "WebviewRecovery.handleSslError(view, currentUrl, error.url)",
            ],
        );
        let wry = wry_android_client_source();
        assert!(wry.contains("return Rust.onPageLoading((view as RustWebView).id, url)"));
        assert!(wry.contains("Rust.onPageLoaded((view as RustWebView).id, url)"));
        let gradle = include_str!("../gen/android/app/build.gradle.kts");
        assert!(gradle.contains("source.occurrencesOf(it.second) == 1"));
        assert!(gradle.contains("wireGeneratedWebViewRecovery"));
        assert!(gradle.contains("verifyGeneratedWebViewRecovery"));
        assert!(gradle.contains("handler.cancel()"));
        assert!(gradle.contains("return Rust.onPageLoading((view as RustWebView).id, url)"));
        assert!(gradle.contains("Rust.onPageLoaded((view as RustWebView).id, url)"));
        assert!(!gradle.contains("WebviewRecovery.handlePageFinished(view, url)"));
        assert!(!gradle.contains("WebviewRecovery.handlePageStarted(view)"));
    }
}
