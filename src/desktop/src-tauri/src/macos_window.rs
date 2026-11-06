use crate::native_geometry::GeometrySnapshot;
use objc2::{msg_send, runtime::AnyObject};
use objc2_foundation::NSRect;
use tauri::WebviewWindow;

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
        if !window
            .is_fullscreen()
            .map_err(|_| "geometry_window_unavailable")?
        {
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
