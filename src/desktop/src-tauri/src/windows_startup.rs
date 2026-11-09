use std::{
    cell::RefCell,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    utils::config::{Config, FrontendDist, ScrollBarStyle, WindowConfig},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use webview2_com::{
    CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment,
        ICoreWebView2EnvironmentOptions, ICoreWebView2_3,
        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY, COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT,
    },
};
use windows::{
    core::{IUnknown, Interface, HRESULT, HSTRING, PCWSTR},
    Win32::{
        Globalization::{
            GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES, MAX_LOCALE_NAME,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
    },
};

use crate::{
    startup_log::{self, Phase},
    windows_startup_state::{CreationGate, EnvironmentChoice},
};

static ENABLED: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

struct PendingEnvironment {
    _directory: HSTRING,
    _options: ICoreWebView2EnvironmentOptions,
    _callback: IUnknown,
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

thread_local! {
    static GATE: RefCell<CreationGate> = const { RefCell::new(CreationGate::new(false)) };
    static APARTMENT: RefCell<Option<Apartment>> = const { RefCell::new(None) };
    static PENDING: RefCell<Option<PendingEnvironment>> = const { RefCell::new(None) };
    static ENVIRONMENT: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
}

pub(crate) fn configure(config: &mut Config) {
    let enabled = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
        .is_some_and(|window| {
            let automatic = window.create;
            if automatic {
                window.create = false;
            }
            automatic
        });
    ENABLED.store(enabled, Ordering::Release);
}

pub(crate) fn owns_main() -> bool {
    ENABLED.load(Ordering::Acquire)
}

pub(crate) fn cancel() {
    CANCELLED.store(true, Ordering::Release);
    GATE.with(|gate| gate.borrow_mut().cancel());
    ENVIRONMENT.with(|environment| {
        environment.borrow_mut().take();
    });
}

pub(crate) fn consume_placeholder(url: &url::Url) -> bool {
    url.as_str() == "about:blank"
        && !CANCELLED.load(Ordering::Acquire)
        && GATE.with(|gate| gate.borrow_mut().consume_placeholder())
}

fn main_config(app: &AppHandle) -> Option<WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
}

fn default_environment_configuration(config: &WindowConfig) -> bool {
    !config.incognito
        && config.proxy_url.is_none()
        && !config.browser_extensions_enabled
        && matches!(config.scroll_bar_style, ScrollBarStyle::Default)
}

pub(crate) fn begin(app: &AppHandle) {
    if !owns_main() || CANCELLED.load(Ordering::Acquire) {
        return;
    }
    GATE.with(|gate| *gate.borrow_mut() = CreationGate::new(true));
    startup_log::mark(Phase::EnvironmentRequested);
    let Some(config) = main_config(app).filter(default_environment_configuration) else {
        complete(app, None);
        return;
    };
    let directory = config
        .data_directory
        .clone()
        .or_else(|| app.path().app_local_data_dir().ok());
    let Some(directory) = directory.filter(|path| std::fs::create_dir_all(path).is_ok()) else {
        complete(app, None);
        return;
    };
    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
        complete(app, None);
        return;
    }
    APARTMENT.with(|apartment| *apartment.borrow_mut() = Some(Apartment));
    let directory = HSTRING::from(directory.as_os_str());
    let options = CoreWebView2EnvironmentOptions::default();
    unsafe {
        options.set_additional_browser_arguments(config.additional_browser_args.unwrap_or_else(|| "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required".into()));
        options.set_are_browser_extensions_enabled(false);
        options.set_scroll_bar_style(COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT);
        let language = GetUserDefaultUILanguage();
        let mut name = [0u16; MAX_LOCALE_NAME as usize];
        LCIDToLocaleName(language as u32, Some(&mut name), LOCALE_ALLOW_NEUTRAL_NAMES);
        options.set_language(String::from_utf16_lossy(&name));
    }
    let options = ICoreWebView2EnvironmentOptions::from(options);
    let owner = app.clone();
    let callback = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |result, environment| {
            let environment = result
                .and_then(|_| {
                    environment.ok_or_else(|| {
                        windows::core::Error::from_hresult(HRESULT(0x80004003u32 as i32))
                    })
                })
                .ok();
            complete(&owner, environment);
            Ok(())
        },
    ));
    let Ok(retained_callback) = callback.cast::<IUnknown>() else {
        complete(app, None);
        return;
    };
    PENDING.with(|pending| {
        *pending.borrow_mut() = Some(PendingEnvironment {
            _directory: directory.clone(),
            _options: options.clone(),
            _callback: retained_callback,
        })
    });
    if unsafe {
        CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &directory, &options, &callback)
    }
    .is_err()
    {
        complete(app, None);
    }
}

fn complete(app: &AppHandle, environment: Option<ICoreWebView2Environment>) {
    if CANCELLED.load(Ordering::Acquire) {
        PENDING.with(|pending| {
            pending.borrow_mut().take();
        });
        return;
    }
    if !GATE.with(|gate| gate.borrow().accepts_environment()) {
        return;
    }
    PENDING.with(|pending| {
        pending.borrow_mut().take();
    });
    let choice = if let Some(environment) = environment {
        ENVIRONMENT.with(|current| *current.borrow_mut() = Some(environment));
        startup_log::mark(Phase::EnvironmentReady);
        EnvironmentChoice::Prebuilt
    } else {
        startup_log::mark(Phase::EnvironmentFallback);
        EnvironmentChoice::Default
    };
    if let Some(choice) = GATE.with(|gate| gate.borrow_mut().environment_ready(choice)) {
        schedule_creation(app, choice);
    }
}

pub(crate) fn setup_complete(app: &AppHandle) {
    if !owns_main() || CANCELLED.load(Ordering::Acquire) {
        return;
    }
    if let Some(choice) = GATE.with(|gate| gate.borrow_mut().setup_ready()) {
        schedule_creation(app, choice);
    }
}

fn post(app: &AppHandle, action: impl FnOnce() + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if app.run_on_main_thread(action).is_err() {
            CANCELLED.store(true, Ordering::Release);
            startup_log::abandon(Phase::InitializationFailed);
            app.exit(1);
        }
    });
}

fn schedule_creation(app: &AppHandle, choice: EnvironmentChoice) {
    let owner = app.clone();
    post(app, move || create_main(&owner, choice, true));
}

fn creation_live() -> bool {
    !CANCELLED.load(Ordering::Acquire) && GATE.with(|gate| gate.borrow().building())
}

fn mapping_eligible(config: &WindowConfig, app: &AppHandle) -> bool {
    if config.use_https_scheme {
        return false;
    }
    match &config.url {
        WebviewUrl::CustomProtocol(url) | WebviewUrl::External(url) => {
            crate::webview_recovery::is_original_bootstrap_url(url)
        }
        WebviewUrl::App(path) if path.to_str() == Some("index.html") && !tauri::is_dev() => {
            matches!(&app.config().build.frontend_dist, Some(FrontendDist::Url(url)) if crate::webview_recovery::is_original_bootstrap_url(url))
        }
        _ => false,
    }
}

fn create_main(app: &AppHandle, choice: EnvironmentChoice, allow_mapping: bool) {
    if !creation_live() {
        return;
    }
    if app.get_window("main").is_some() {
        fail(app);
        return;
    }
    let Some(mut config) = main_config(app) else {
        fail(app);
        return;
    };
    let mapping = if allow_mapping && mapping_eligible(&config, app) {
        let (_, body) = crate::webview_recovery::mapped_bootstrap_document();
        app.path().app_cache_dir().ok().and_then(|root| {
            crate::startup_assets::prepare(&root.join("native-startup"), body.as_bytes()).ok()
        })
    } else {
        None
    };
    if mapping.is_some() {
        config.url =
            WebviewUrl::External(url::Url::parse("about:blank").expect("fixed creation URL"));
        GATE.with(|gate| gate.borrow_mut().permit_placeholder());
    }
    let environment = ENVIRONMENT.with(|environment| environment.borrow().clone());
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| {
        match (choice, environment) {
            (EnvironmentChoice::Prebuilt, Some(environment)) => {
                builder.with_environment(environment).build()
            }
            _ => builder.build(),
        }
    });
    let window = match built {
        Ok(window) => window,
        Err(_)
            if choice == EnvironmentChoice::Prebuilt
                && creation_live()
                && GATE.with(|gate| gate.borrow_mut().default_retry()) =>
        {
            ENVIRONMENT.with(|environment| {
                environment.borrow_mut().take();
            });
            if let Some(partial) = app.get_window("main") {
                if partial.destroy().is_err() {
                    fail(app);
                    return;
                }
            }
            startup_log::mark(Phase::EnvironmentFallback);
            let owner = app.clone();
            post(app, move || {
                create_main(&owner, EnvironmentChoice::Default, false)
            });
            return;
        }
        Err(_) => {
            fail(app);
            return;
        }
    };
    if !creation_live() {
        let _ = window.destroy();
        return;
    }
    startup_log::mark(Phase::MainWindowCreated);
    let ready = window.clone();
    let dispatched = window.with_webview(move |platform| {
        ENVIRONMENT.with(|environment| *environment.borrow_mut() = Some(platform.environment()));
        let navigation_ok = if let Some(directory) = mapping {
            let result = unsafe { platform.controller().CoreWebView2() };
            if let Ok(core) = result {
                let mapped = core
                    .cast::<ICoreWebView2_3>()
                    .and_then(|mapping| unsafe {
                        mapping.SetVirtualHostNameToFolderMapping(
                            &HSTRING::from(crate::webview_recovery::MAPPED_HOST),
                            &HSTRING::from(directory.as_os_str()),
                            COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY,
                        )
                    })
                    .is_ok();
                if mapped
                    && unsafe {
                        core.Navigate(&HSTRING::from(
                            crate::webview_recovery::MAPPED_BOOTSTRAP_URL,
                        ))
                    }
                    .is_ok()
                {
                    startup_log::mark(Phase::BootstrapMapped);
                    true
                } else {
                    startup_log::mark(Phase::BootstrapMappingFallback);
                    unsafe {
                        core.Navigate(&HSTRING::from(
                            crate::webview_recovery::WINDOWS_BOOTSTRAP_URL,
                        ))
                    }
                    .is_ok()
                }
            } else {
                false
            }
        } else {
            startup_log::mark(Phase::BootstrapMappingFallback);
            true
        };
        let owner = ready.app_handle().clone();
        post(&owner, move || finish_main(ready, navigation_ok));
    });
    if dispatched.is_err() {
        fail(app);
    }
}

fn finish_main(window: WebviewWindow, navigation_ok: bool) {
    if !creation_live() {
        let _ = window.destroy();
        return;
    }
    let app = window.app_handle().clone();
    if !navigation_ok || !GATE.with(|gate| gate.borrow_mut().created()) {
        fail(&app);
        return;
    }
    if crate::finish_windows_main_creation(&window).is_err() {
        fail(&app);
    }
}

fn fail(app: &AppHandle) {
    if CANCELLED.swap(true, Ordering::AcqRel) {
        return;
    }
    GATE.with(|gate| gate.borrow_mut().cancel());
    startup_log::abandon(Phase::InitializationFailed);
    crate::commands::show_startup_initialization_error(app);
}
