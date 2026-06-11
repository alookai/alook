use tauri::WebviewWindow;

const INSET_TOP: f64 = 38.0;
const INSET_SIDE: f64 = 8.0;
const INSET_BOTTOM: f64 = 8.0;
const CORNER_RADIUS: f64 = 10.0;

pub fn setup_inset_webview(window: &WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::msg_send;

    unsafe {
        let ns_view = window.ns_view().unwrap() as *mut AnyObject;

        // Enable layer-backed view for corner radius
        let _: () = msg_send![ns_view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![ns_view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: CORNER_RADIUS];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }

        let superview: *mut AnyObject = msg_send![ns_view, superview];
        if superview.is_null() {
            return;
        }

        // Opt in to Auto Layout for the webview
        let _: () = msg_send![ns_view, setTranslatesAutoresizingMaskIntoConstraints: false];

        // Remove any existing constraints on the webview (WRY may have added some)
        let existing: *mut AnyObject = msg_send![ns_view, constraints];
        let count: usize = msg_send![existing, count];
        for i in 0..count {
            let c: *mut AnyObject = msg_send![existing, objectAtIndex: i];
            let _: () = msg_send![ns_view, removeConstraint: c];
        }

        // Also remove superview constraints that reference this view
        let sv_constraints: *mut AnyObject = msg_send![superview, constraints];
        let sv_count: usize = msg_send![sv_constraints, count];
        // Iterate in reverse so removal doesn't shift indices
        for i in (0..sv_count).rev() {
            let c: *mut AnyObject = msg_send![sv_constraints, objectAtIndex: i];
            let first_item: *mut AnyObject = msg_send![c, firstItem];
            let second_item: *mut AnyObject = msg_send![c, secondItem];
            if first_item == ns_view || second_item == ns_view {
                let _: () = msg_send![superview, removeConstraint: c];
            }
        }

        // Pin webview to superview edges with insets using Auto Layout.
        // These constraints resize the webview synchronously during layout,
        // eliminating the flicker from async resize event handlers.

        // leading: webview.leading = superview.leading + INSET_SIDE
        let leading: *mut AnyObject = msg_send![ns_view, leadingAnchor];
        let sv_leading: *mut AnyObject = msg_send![superview, leadingAnchor];
        let c: *mut AnyObject = msg_send![leading, constraintEqualToAnchor: sv_leading, constant: INSET_SIDE];
        let _: () = msg_send![c, setActive: true];

        // trailing: superview.trailing = webview.trailing + INSET_SIDE
        let trailing: *mut AnyObject = msg_send![ns_view, trailingAnchor];
        let sv_trailing: *mut AnyObject = msg_send![superview, trailingAnchor];
        let c: *mut AnyObject = msg_send![sv_trailing, constraintEqualToAnchor: trailing, constant: INSET_SIDE];
        let _: () = msg_send![c, setActive: true];

        // top: webview.top = superview.top + INSET_TOP
        let top: *mut AnyObject = msg_send![ns_view, topAnchor];
        let sv_top: *mut AnyObject = msg_send![superview, topAnchor];
        let c: *mut AnyObject = msg_send![top, constraintEqualToAnchor: sv_top, constant: INSET_TOP];
        let _: () = msg_send![c, setActive: true];

        // bottom: superview.bottom = webview.bottom + INSET_BOTTOM
        let bottom: *mut AnyObject = msg_send![ns_view, bottomAnchor];
        let sv_bottom: *mut AnyObject = msg_send![superview, bottomAnchor];
        let c: *mut AnyObject = msg_send![sv_bottom, constraintEqualToAnchor: bottom, constant: INSET_BOTTOM];
        let _: () = msg_send![c, setActive: true];
    }
}

