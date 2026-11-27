#[cfg(desktop)]
use serde::Serialize;
use tauri::plugin::TauriPlugin;
#[cfg(desktop)]
use tauri::WebviewWindow;

fn runtime_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "ios")]
    {
        "ios"
    }
    #[cfg(target_os = "android")]
    {
        "android"
    }
}

fn runtime_form_factor() -> &'static str {
    if cfg!(desktop) {
        "desktop"
    } else {
        "mobile"
    }
}

fn runtime_descriptor_script(platform: &str, form_factor: &str) -> String {
    format!(
        r#"(function(platform,formFactor){{if(window.top!==window)return;if(Object.prototype.hasOwnProperty.call(window,'__ALOOK_NATIVE_RUNTIME__'))return;Object.defineProperty(window,'__ALOOK_NATIVE_RUNTIME__',{{value:Object.freeze({{platform:platform,formFactor:formFactor}}),writable:false,enumerable:false,configurable:false}});}})({platform:?},{form_factor:?});"#
    )
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("native-geometry")
        .js_init_script(format!(
            "{}\n({})({})",
            runtime_descriptor_script(runtime_platform(), runtime_form_factor()),
            include_str!("native_geometry.js"),
            cfg!(desktop)
        ))
        .build()
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometrySnapshot {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub caption: bool,
}

#[cfg(desktop)]
#[tauri::command]
pub async fn native_geometry_snapshot(window: WebviewWindow) -> Result<GeometrySnapshot, String> {
    let url = window.url().map_err(|_| "geometry_document_unavailable")?;
    if !caller_allowed(window.label(), &url, tauri::is_dev()) {
        return Err("untrusted_geometry_caller".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    #[cfg(target_os = "macos")]
    window
        .with_webview(move |platform| {
            let result = crate::macos_window::measure_geometry(&target, platform.inner());
            let _ = sender.send(result);
        })
        .map_err(|_| "geometry_view_unavailable")?;
    #[cfg(not(target_os = "macos"))]
    window
        .run_on_main_thread(move || {
            let result = target
                .inner_size()
                .map_err(|_| "geometry_size_unavailable".to_string())
                .and_then(|size| {
                    if size.width == 0 || size.height == 0 {
                        return Err("geometry_size_unavailable".into());
                    }
                    Ok(GeometrySnapshot {
                        top: 0.0,
                        right: 0.0,
                        bottom: 0.0,
                        left: 0.0,
                        viewport_width: size.width as f64,
                        viewport_height: size.height as f64,
                        caption: false,
                    })
                });
            let _ = sender.send(result);
        })
        .map_err(|_| "geometry_thread_unavailable")?;
    receiver
        .await
        .map_err(|_| "geometry_view_unavailable".to_string())?
}

#[cfg(desktop)]
pub fn changed(window: &WebviewWindow) {
    let _ = window.eval("window.dispatchEvent(new Event('alook:geometry-change'))");
}

#[cfg(desktop)]
fn caller_allowed(label: &str, url: &url::Url, development: bool) -> bool {
    label == "main" && crate::webview_recovery::navigation_allowed(url, development)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::{caller_allowed, runtime_descriptor_script, runtime_form_factor, runtime_platform};
    use url::Url;

    #[test]
    fn permits_only_trusted_main_documents_and_owned_recovery_routes() {
        for target in [
            "https://alook.ai/c",
            "alook-recovery://localhost/bootstrap",
            "alook-recovery://localhost/network-error#target=https%3A%2F%2Falook.ai%2Fc",
        ] {
            let url = Url::parse(target).unwrap();
            assert!(caller_allowed("main", &url, false), "rejected {target}");
            assert!(!caller_allowed("splash", &url, false));
        }
        let http_recovery = Url::parse("http://alook-recovery.localhost/network-error").unwrap();
        assert_eq!(
            caller_allowed("main", &http_recovery, false),
            cfg!(any(windows, target_os = "android"))
        );
        let local = Url::parse("http://localhost:3000/sign-in").unwrap();
        assert!(caller_allowed("main", &local, true));
        assert!(!caller_allowed("main", &local, false));
        for target in [
            "https://alook.ai.evil.example/c",
            "https://alook.ai:8443/c",
            "http://alook.ai/c",
            "https://user@alook.ai/c",
            "http://localhost:3001/c",
            "alook-recovery://elsewhere/bootstrap",
            "alook-recovery://localhost/unknown",
            "alook-recovery://localhost/bootstrap?unowned=1",
            "https://alook-recovery.localhost/network-error",
        ] {
            let url = Url::parse(target).unwrap();
            assert!(!caller_allowed("main", &url, false), "accepted {target}");
            assert!(!caller_allowed("main", &url, true), "accepted dev {target}");
        }
    }

    #[test]
    fn runtime_descriptor_is_top_frame_only_and_immutable() {
        let script = runtime_descriptor_script(runtime_platform(), runtime_form_factor());
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(
                r#"
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = process.argv[1];
const expectedPlatform = process.argv[2];
const expectedFormFactor = process.argv[3];

const topWindow = {};
topWindow.top = topWindow;
topWindow.window = topWindow;
vm.runInNewContext(script, topWindow);
assert.equal(topWindow.__ALOOK_NATIVE_RUNTIME__.platform, expectedPlatform);
assert.equal(topWindow.__ALOOK_NATIVE_RUNTIME__.formFactor, expectedFormFactor);
assert.deepEqual(Object.keys(topWindow.__ALOOK_NATIVE_RUNTIME__).sort(), ['formFactor', 'platform']);
assert.equal(Object.isFrozen(topWindow.__ALOOK_NATIVE_RUNTIME__), true);
const descriptor = Object.getOwnPropertyDescriptor(topWindow, '__ALOOK_NATIVE_RUNTIME__');
assert.equal(descriptor.writable, false);
assert.equal(descriptor.configurable, false);
assert.throws(() => {
  'use strict';
  topWindow.__ALOOK_NATIVE_RUNTIME__ = { platform: 'spoofed', formFactor: 'mobile' };
});

const iframeWindow = { top: {} };
iframeWindow.window = iframeWindow;
vm.runInNewContext(script, iframeWindow);
assert.equal('__ALOOK_NATIVE_RUNTIME__' in iframeWindow, false);
"#,
            )
            .arg(&script)
            .arg(runtime_platform())
            .arg(runtime_form_factor())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
