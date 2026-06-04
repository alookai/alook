use tauri::WebviewWindow;

const INSET_TOP: f64 = 38.0;
const INSET_SIDE: f64 = 8.0;
const INSET_BOTTOM: f64 = 8.0;
const CORNER_RADIUS: f64 = 10.0;

pub fn setup_inset_webview(window: &WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_app_kit::{NSWindow, NSColor};
    use objc2_foundation::NSRect;

    let ns_window: Retained<NSWindow> = unsafe {
        let ptr: *mut AnyObject = msg_send![window.ns_window().unwrap() as *mut AnyObject, retain];
        Retained::from_raw(ptr.cast()).unwrap()
    };

    unsafe {
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));

        let content_view = ns_window.contentView().unwrap();
        let subviews = content_view.subviews();
        let count: usize = msg_send![&*subviews, count];

        if count > 0 {
            let webview: *mut AnyObject = msg_send![&*subviews, objectAtIndex: 0usize];

            // Enable layer-backed view for corner radius
            let _: () = msg_send![webview, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![webview, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: CORNER_RADIUS];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }

            // Set inset frame
            let content_frame = content_view.frame();
            let inset_frame = NSRect::new(
                objc2_foundation::NSPoint::new(INSET_SIDE, INSET_BOTTOM),
                objc2_foundation::NSSize::new(
                    content_frame.size.width - INSET_SIDE * 2.0,
                    content_frame.size.height - INSET_TOP - INSET_BOTTOM,
                ),
            );
            let _: () = msg_send![webview, setFrame: inset_frame];

            // Disable autoresizing mask so our manual frame sticks
            let _: () = msg_send![webview, setAutoresizingMask: 0u64];
        }
    }
}

pub fn update_webview_frame(window: &tauri::Window) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_app_kit::NSWindow;
    use objc2_foundation::NSRect;

    let ns_window: Retained<NSWindow> = unsafe {
        let ptr: *mut AnyObject = msg_send![window.ns_window().unwrap() as *mut AnyObject, retain];
        Retained::from_raw(ptr.cast()).unwrap()
    };

    unsafe {
        let content_view = ns_window.contentView().unwrap();
        let subviews = content_view.subviews();
        let count: usize = msg_send![&*subviews, count];

        if count > 0 {
            let webview: *mut AnyObject = msg_send![&*subviews, objectAtIndex: 0usize];
            let content_frame = content_view.frame();
            let inset_frame = NSRect::new(
                objc2_foundation::NSPoint::new(INSET_SIDE, INSET_BOTTOM),
                objc2_foundation::NSSize::new(
                    content_frame.size.width - INSET_SIDE * 2.0,
                    content_frame.size.height - INSET_TOP - INSET_BOTTOM,
                ),
            );
            let _: () = msg_send![webview, setFrame: inset_frame];
        }
    }
}
