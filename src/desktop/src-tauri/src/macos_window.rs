use crate::native_geometry::GeometrySnapshot;
use block2::RcBlock;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    MainThreadMarker,
};
use objc2_app_kit::NSWindowDidExitFullScreenNotification;
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSRect};
use std::{
    ptr::NonNull,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Manager, WebviewWindow};

struct FullscreenExitObserver {
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    _block: RcBlock<dyn Fn(NonNull<NSNotification>)>,
}

unsafe impl Send for FullscreenExitObserver {}

impl Drop for FullscreenExitObserver {
    fn drop(&mut self) {
        let center = NSNotificationCenter::defaultCenter();
        unsafe {
            let observer = &*Retained::as_ptr(&self.token).cast::<AnyObject>();
            center.removeObserver(observer);
        }
    }
}

static FULLSCREEN_EXIT_OBSERVER: Mutex<Option<FullscreenExitObserver>> = Mutex::new(None);
static FULLSCREEN_EXIT_GENERATION: AtomicU64 = AtomicU64::new(0);

fn install_fullscreen_exit_observer(
    object: &AnyObject,
    on_exit: impl Fn() + 'static,
) -> FullscreenExitObserver {
    let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
        on_exit();
    });
    let center = NSNotificationCenter::defaultCenter();
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidExitFullScreenNotification),
            Some(object),
            None,
            &block,
        )
    };
    FullscreenExitObserver {
        token,
        _block: block,
    }
}

pub fn observe_fullscreen_exit(window: &WebviewWindow) {
    let generation = FULLSCREEN_EXIT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let target = window.clone();
    let register = move || {
        if FULLSCREEN_EXIT_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let Ok(pointer) = target.ns_window() else {
            return;
        };
        let native_window = pointer.cast::<AnyObject>();
        if native_window.is_null() {
            return;
        }
        let app = target.app_handle().clone();
        let observer = install_fullscreen_exit_observer(unsafe { &*native_window }, move || {
            if let Some(webview) = app.get_webview_window("main") {
                crate::native_geometry::changed(&webview);
            }
        });
        let previous = FULLSCREEN_EXIT_OBSERVER.lock().ok().and_then(|mut slot| {
            if FULLSCREEN_EXIT_GENERATION.load(Ordering::SeqCst) == generation {
                slot.replace(observer)
            } else {
                Some(observer)
            }
        });
        drop(previous);
    };
    if MainThreadMarker::new().is_some() {
        register();
    } else {
        let _ = window.run_on_main_thread(register);
    }
}

pub fn retire_fullscreen_exit_observer() {
    FULLSCREEN_EXIT_GENERATION.fetch_add(1, Ordering::SeqCst);
    let previous = FULLSCREEN_EXIT_OBSERVER
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    drop(previous);
}

fn validate_top_inset(top: f64, fullscreen: bool) -> Result<f64, String> {
    if !fullscreen && (!top.is_finite() || top <= 0.0) {
        return Err("geometry_caption_unavailable".into());
    }
    Ok(top)
}

pub fn measure_geometry(
    window: &WebviewWindow,
    pointer: *mut std::ffi::c_void,
) -> Result<GeometrySnapshot, String> {
    unsafe {
        if pointer.is_null() {
            return Err("geometry_view_unavailable".into());
        }
        let view = pointer.cast::<AnyObject>();
        let native_window = window
            .ns_window()
            .map_err(|_| "geometry_window_unavailable")?
            as *mut AnyObject;
        let attached: *mut AnyObject = msg_send![view, window];
        if attached != native_window {
            return Err("geometry_view_unavailable".into());
        }
        let bounds: NSRect = msg_send![view, bounds];
        let width = bounds.size.width;
        let height = bounds.size.height;
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err("geometry_size_unavailable".into());
        }
        let layout: NSRect = msg_send![native_window, contentLayoutRect];
        if !layout.size.width.is_finite()
            || !layout.size.height.is_finite()
            || layout.size.width <= 0.0
            || layout.size.height <= 0.0
        {
            return Err("geometry_layout_unavailable".into());
        }
        let safe: NSRect =
            msg_send![view, convertRect: layout, fromView: std::ptr::null::<AnyObject>()];
        if ![
            bounds.origin.x,
            bounds.origin.y,
            safe.origin.x,
            safe.origin.y,
            safe.size.width,
            safe.size.height,
        ]
        .iter()
        .all(|value| value.is_finite())
            || safe.size.width < 0.0
            || safe.size.height < 0.0
        {
            return Err("geometry_layout_unavailable".into());
        }
        let flipped: bool = msg_send![view, isFlipped];
        let left = (safe.origin.x - bounds.origin.x).clamp(0.0, width);
        let right =
            (bounds.origin.x + width - safe.origin.x - safe.size.width).clamp(0.0, width - left);
        let low = (safe.origin.y - bounds.origin.y).clamp(0.0, height);
        let high =
            (bounds.origin.y + height - safe.origin.y - safe.size.height).clamp(0.0, height - low);
        let (mut top, bottom) = if flipped { (low, high) } else { (high, low) };
        let fullscreen = window
            .is_fullscreen()
            .map_err(|_| "geometry_window_unavailable")?;
        if !fullscreen {
            for button_type in [0usize, 1, 2] {
                let button: *mut AnyObject =
                    msg_send![native_window, standardWindowButton: button_type];
                if button.is_null() {
                    continue;
                }
                let button_window: *mut AnyObject = msg_send![button, window];
                if button_window != native_window {
                    continue;
                }
                let hidden: bool = msg_send![button, isHidden];
                if hidden {
                    continue;
                }
                let button_bounds: NSRect = msg_send![button, bounds];
                let rect: NSRect = msg_send![view, convertRect: button_bounds, fromView: button];
                let occupied = if flipped {
                    rect.origin.y + rect.size.height - bounds.origin.y
                } else {
                    bounds.origin.y + height - rect.origin.y
                };
                top = top.max(occupied.clamp(0.0, height - bottom));
            }
        }
        let top = validate_top_inset(top, fullscreen)?;
        Ok(GeometrySnapshot {
            top,
            right,
            bottom,
            left,
            viewport_width: width,
            viewport_height: height,
            caption: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_app_kit::NSWindowDidEnterFullScreenNotification;
    use objc2_foundation::NSObject;
    use std::sync::{atomic::AtomicUsize, Arc};

    #[test]
    fn fullscreen_exit_observer_scopes_to_window_and_retires_cleanly() {
        let target = NSObject::new();
        let other = NSObject::new();
        let target_ref: &AnyObject = target.as_ref();
        let other_ref: &AnyObject = other.as_ref();
        let center = NSNotificationCenter::defaultCenter();

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let observer = install_fullscreen_exit_observer(target_ref, move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        unsafe {
            center.postNotificationName_object(NSWindowDidExitFullScreenNotification, Some(other_ref));
            center.postNotificationName_object(NSWindowDidExitFullScreenNotification, None);
            center.postNotificationName_object(
                NSWindowDidEnterFullScreenNotification,
                Some(target_ref),
            );
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        unsafe {
            center.postNotificationName_object(
                NSWindowDidExitFullScreenNotification,
                Some(target_ref),
            );
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        let replacement_hits = Arc::new(AtomicUsize::new(0));
        let replacement_counter = replacement_hits.clone();
        drop(observer);
        let replacement = install_fullscreen_exit_observer(target_ref, move || {
            replacement_counter.fetch_add(1, Ordering::SeqCst);
        });

        unsafe {
            center.postNotificationName_object(
                NSWindowDidExitFullScreenNotification,
                Some(target_ref),
            );
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(replacement_hits.load(Ordering::SeqCst), 1);

        drop(replacement);
        unsafe {
            center.postNotificationName_object(
                NSWindowDidExitFullScreenNotification,
                Some(target_ref),
            );
        }
        assert_eq!(replacement_hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn rejects_transient_zero_top_inset_outside_fullscreen_only() {
        assert_eq!(validate_top_inset(32.0, false), Ok(32.0));
        assert_eq!(
            validate_top_inset(0.0, false),
            Err("geometry_caption_unavailable".into())
        );
        assert_eq!(
            validate_top_inset(-1.0, false),
            Err("geometry_caption_unavailable".into())
        );
        assert_eq!(
            validate_top_inset(f64::NAN, false),
            Err("geometry_caption_unavailable".into())
        );
        assert_eq!(validate_top_inset(0.0, true), Ok(0.0));
    }
}
