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

#[cfg(all(desktop, any(test, not(target_os = "macos"))))]
fn logical_viewport_size(width: u32, height: u32, scale_factor: f64) -> Result<(f64, f64), String> {
    if width == 0 || height == 0 {
        return Err("geometry_size_unavailable".into());
    }
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let logical_width = width as f64 / scale;
    let logical_height = height as f64 / scale;
    if !logical_width.is_finite()
        || !logical_height.is_finite()
        || logical_width <= 0.0
        || logical_height <= 0.0
    {
        return Err("geometry_size_unavailable".into());
    }
    Ok((logical_width, logical_height))
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
            let scale = target.scale_factor().unwrap_or(1.0);
            let result = target
                .inner_size()
                .map_err(|_| "geometry_size_unavailable".to_string())
                .and_then(|size| {
                    let (viewport_width, viewport_height) =
                        logical_viewport_size(size.width, size.height, scale)?;
                    Ok(GeometrySnapshot {
                        top: 0.0,
                        right: 0.0,
                        bottom: 0.0,
                        left: 0.0,
                        viewport_width,
                        viewport_height,
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
    use super::{
        caller_allowed, logical_viewport_size, runtime_descriptor_script, runtime_form_factor,
        runtime_platform,
    };
    use url::Url;

    #[test]
    fn logical_viewport_size_divides_physical_dimensions_by_scale_factor() {
        assert_eq!(logical_viewport_size(2400, 1600, 2.0), Ok((1200.0, 800.0)));
        assert_eq!(logical_viewport_size(1920, 1080, 1.5), Ok((1280.0, 720.0)));
        assert_eq!(logical_viewport_size(1200, 800, 0.0), Ok((1200.0, 800.0)));
        assert_eq!(
            logical_viewport_size(1200, 800, f64::NAN),
            Ok((1200.0, 800.0))
        );
        assert!(logical_viewport_size(0, 800, 2.0).is_err());
        assert!(logical_viewport_size(1200, 0, 2.0).is_err());
    }

    #[test]
    fn geometry_script_preserves_last_valid_insets_on_transient_errors_and_retries_on_mobile() {
        let script = include_str!("native_geometry.js");
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(
                r#"
const vm = require('node:vm');
const assert = require('node:assert/strict');
const factorySource = process.argv[1];

function createEnv({ desktop, responses }) {
  const styles = new Map();
  const dataset = {};
  const listeners = new Map();
  const timers = [];
  let nextTimerId = 1;
  let callIndex = 0;

  const docElement = {
    dataset,
    style: {
      setProperty: (k, v) => styles.set(k, v),
      removeProperty: (k) => styles.delete(k),
    },
  };
  const win = {
    document: {
      documentElement: docElement,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    __TAURI__: {
      webview: { getCurrentWebview: () => ({ label: 'main' }) },
      core: {
        invoke: async () => {
          const next = responses[callIndex++];
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.push({ id, fn, delay, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      const entry = timers.find(t => t.id === id);
      if (entry) entry.cleared = true;
    },
    Event: class Event { constructor(type) { this.type = type; } },
  };
  if (!desktop) {
    win.__alookNativeBridge = {
      getGeometrySnapshot: () => {
        const next = responses[callIndex++];
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }
  win.window = win;
  win.top = win;

  vm.runInNewContext(`(${factorySource})(${desktop})`, win);
  return { win, styles, dataset, timers };
}

(async () => {
  const valid = { top: 38, right: 0, bottom: 0, left: 0, viewportWidth: 1000, viewportHeight: 700, caption: true };
  const desktopEnv = createEnv({
    desktop: true,
    responses: [valid, new Error('minimized 0x0'), valid],
  });
  await new Promise(r => setImmediate(r));
  assert.equal(desktopEnv.dataset.alookNativeGeometry, 'ready');
  assert.equal(desktopEnv.styles.get('--app-safe-area-top'), '3.8vw');
  assert.equal(desktopEnv.dataset.alookNativeCaption, 'true');

  desktopEnv.win.dispatchEvent(new desktopEnv.win.Event('resize'));
  await new Promise(r => setImmediate(r));
  assert.equal(desktopEnv.dataset.alookNativeGeometry, 'error');
  assert.equal(desktopEnv.styles.get('--app-safe-area-top'), '3.8vw');
  assert.equal(desktopEnv.dataset.alookNativeCaption, 'true');
  assert.equal(desktopEnv.win.__alookNativeGeometry.getSnapshot().insets.top, 38);

  const retryTimer = desktopEnv.timers.find(t => !t.cleared);
  assert.ok(retryTimer, 'expected scheduled retry');
  retryTimer.fn();
  await new Promise(r => setImmediate(r));
  assert.equal(desktopEnv.dataset.alookNativeGeometry, 'ready');

  const mobileValid = { top: 44, right: 0, bottom: 34, left: 0, viewportWidth: 390, viewportHeight: 844, caption: false };
  const mobileEnv = createEnv({
    desktop: false,
    responses: [null, mobileValid],
  });
  await new Promise(r => setImmediate(r));
  assert.equal(mobileEnv.dataset.alookNativeGeometry, 'error');
  const mobileRetry = mobileEnv.timers.find(t => !t.cleared);
  assert.ok(mobileRetry, 'expected mobile retry after initial invalid snapshot');
  mobileRetry.fn();
  await new Promise(r => setImmediate(r));
  assert.equal(mobileEnv.dataset.alookNativeGeometry, 'ready');
  assert.equal(mobileEnv.win.__alookNativeGeometry.getSnapshot().insets.bottom, 34);
})();
"#,
            )
            .arg(script)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

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
