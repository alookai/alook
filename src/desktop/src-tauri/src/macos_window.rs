use tauri::WebviewWindow;

const INSET_TOP: f64 = 38.0;
const INSET_SIDE: f64 = 0.0;
const INSET_BOTTOM: f64 = 0.0;
const CORNER_RADIUS: f64 = 10.0;
const NS_LAYOUT_ATTRIBUTE_TOP: isize = 3;

fn top_inset(fullscreen: bool) -> f64 {
    if fullscreen {
        0.0
    } else {
        INSET_TOP
    }
}

pub fn setup_inset_webview(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || setup_inset_webview_on_main(&target));
}

fn setup_inset_webview_on_main(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

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
        let c: *mut AnyObject =
            msg_send![leading, constraintEqualToAnchor: sv_leading, constant: INSET_SIDE];
        let _: () = msg_send![c, setActive: true];

        // trailing: superview.trailing = webview.trailing + INSET_SIDE
        let trailing: *mut AnyObject = msg_send![ns_view, trailingAnchor];
        let sv_trailing: *mut AnyObject = msg_send![superview, trailingAnchor];
        let c: *mut AnyObject =
            msg_send![sv_trailing, constraintEqualToAnchor: trailing, constant: INSET_SIDE];
        let _: () = msg_send![c, setActive: true];

        // top: webview.top = superview.top + INSET_TOP
        let top: *mut AnyObject = msg_send![ns_view, topAnchor];
        let sv_top: *mut AnyObject = msg_send![superview, topAnchor];
        let c: *mut AnyObject =
            msg_send![top, constraintEqualToAnchor: sv_top, constant: INSET_TOP];
        let _: () = msg_send![c, setActive: true];

        // bottom: superview.bottom = webview.bottom + INSET_BOTTOM
        let bottom: *mut AnyObject = msg_send![ns_view, bottomAnchor];
        let sv_bottom: *mut AnyObject = msg_send![superview, bottomAnchor];
        let c: *mut AnyObject =
            msg_send![sv_bottom, constraintEqualToAnchor: bottom, constant: INSET_BOTTOM];
        let _: () = msg_send![c, setActive: true];
    }
}

pub fn update_inset_webview(window: &WebviewWindow) {
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let target = window.clone();
    let _ = window.run_on_main_thread(move || update_inset_webview_on_main(&target, fullscreen));
}

fn update_inset_webview_on_main(window: &WebviewWindow, fullscreen: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    unsafe {
        let ns_view = window.ns_view().unwrap() as *mut AnyObject;
        let layer: *mut AnyObject = msg_send![ns_view, layer];
        if !layer.is_null() {
            let radius = if fullscreen { 0.0 } else { CORNER_RADIUS };
            let _: () = msg_send![layer, setCornerRadius: radius];
        }

        let superview: *mut AnyObject = msg_send![ns_view, superview];
        if superview.is_null() {
            return;
        }
        let constraints: *mut AnyObject = msg_send![superview, constraints];
        let count: usize = msg_send![constraints, count];
        for index in 0..count {
            let constraint: *mut AnyObject = msg_send![constraints, objectAtIndex: index];
            let first_item: *mut AnyObject = msg_send![constraint, firstItem];
            let second_item: *mut AnyObject = msg_send![constraint, secondItem];
            let first_attribute: isize = msg_send![constraint, firstAttribute];
            let second_attribute: isize = msg_send![constraint, secondAttribute];
            if first_item == ns_view
                && second_item == superview
                && first_attribute == NS_LAYOUT_ATTRIBUTE_TOP
                && second_attribute == NS_LAYOUT_ATTRIBUTE_TOP
            {
                let inset = top_inset(fullscreen);
                let _: () = msg_send![constraint, setConstant: inset];
                let _: () = msg_send![superview, layoutSubtreeIfNeeded];
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_top_inset() {
        assert_eq!(INSET_TOP, 38.0);
        assert_eq!(INSET_SIDE, 0.0);
        assert_eq!(INSET_BOTTOM, 0.0);
    }

    #[test]
    fn fullscreen_uses_the_top_constraint_attribute() {
        assert_eq!(NS_LAYOUT_ATTRIBUTE_TOP, 3);
        assert_eq!(top_inset(true), 0.0);
        assert_eq!(top_inset(false), 38.0);
    }
}
