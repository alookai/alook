use tauri::WebviewWindow;

const INSET_TOP: f64 = 38.0;
const INSET_SIDE: f64 = 8.0;
const INSET_BOTTOM: f64 = 8.0;
const CORNER_RADIUS: f64 = 10.0;

pub fn setup_inset_webview(window: &WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_foundation::NSRect;

    unsafe {
        // Get the WKWebView directly
        let ns_view = window.ns_view().unwrap() as *mut AnyObject;

        // Enable layer-backed view for corner radius
        let _: () = msg_send![ns_view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![ns_view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: CORNER_RADIUS];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }

        // Get the superview (content view) to calculate frame
        let superview: *mut AnyObject = msg_send![ns_view, superview];
        if !superview.is_null() {
            let superview_frame: NSRect = msg_send![superview, frame];

            let inset_frame = NSRect::new(
                objc2_foundation::NSPoint::new(INSET_SIDE, INSET_BOTTOM),
                objc2_foundation::NSSize::new(
                    superview_frame.size.width - INSET_SIDE * 2.0,
                    superview_frame.size.height - INSET_TOP - INSET_BOTTOM,
                ),
            );
            let _: () = msg_send![ns_view, setFrame: inset_frame];

            // Disable autoresizing mask so our manual frame sticks
            let _: () = msg_send![ns_view, setAutoresizingMask: 0u64];
        }
    }
}

pub fn update_webview_frame(window: &tauri::Window) {
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_foundation::NSRect;

    unsafe {
        let ns_window = window.ns_window().unwrap() as *mut AnyObject;
        let content_view: *mut AnyObject = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }

        let content_frame: NSRect = msg_send![content_view, frame];

        // Find the webview — it's the subview we set the corner radius on
        let subviews: *mut AnyObject = msg_send![content_view, subviews];
        let count: usize = msg_send![subviews, count];

        for i in 0..count {
            let view: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            let layer: *mut AnyObject = msg_send![view, layer];
            if layer.is_null() {
                continue;
            }
            let radius: f64 = msg_send![layer, cornerRadius];
            if radius > 0.0 {
                let inset_frame = NSRect::new(
                    objc2_foundation::NSPoint::new(INSET_SIDE, INSET_BOTTOM),
                    objc2_foundation::NSSize::new(
                        content_frame.size.width - INSET_SIDE * 2.0,
                        content_frame.size.height - INSET_TOP - INSET_BOTTOM,
                    ),
                );
                let _: () = msg_send![view, setFrame: inset_frame];
                break;
            }
        }
    }
}
