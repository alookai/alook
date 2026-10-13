use tauri::WebviewWindow;

pub(crate) fn development_origin_allowed(url: &url::Url, development: bool, mobile: bool) -> bool {
    development
        && url.username().is_empty()
        && url.password().is_none()
        && (url.origin().ascii_serialization() == "http://localhost:3000"
            || (mobile
                && ((url.scheme() == "tauri"
                    && url.host_str() == Some("localhost")
                    && url.port().is_none())
                    || (url.scheme() == "http"
                        && url.host_str() == Some("tauri.localhost")
                        && url.port_or_known_default() == Some(80)))))
}

pub fn caller_allowed(label: &str, url: &url::Url, development: bool, mobile: bool) -> bool {
    let expected = "https://alook.ai";
    label == "main"
        && url.username().is_empty()
        && url.password().is_none()
        && if development {
            development_origin_allowed(url, development, mobile)
        } else {
            url.origin().ascii_serialization() == expected
        }
}

pub fn guard(window: &WebviewWindow) -> Result<(), &'static str> {
    let url = window.url().map_err(|_| "untrusted_caller")?;
    if caller_allowed(window.label(), &url, tauri::is_dev(), cfg!(mobile)) {
        Ok(())
    } else {
        Err("untrusted_caller")
    }
}

#[cfg(test)]
mod tests {
    use super::caller_allowed;

    #[test]
    fn accepts_only_the_main_window_and_exact_origin() {
        assert!(caller_allowed(
            "main",
            &url::Url::parse("https://alook.ai/c").unwrap(),
            false,
            false,
        ));
        assert!(caller_allowed(
            "main",
            &url::Url::parse("http://localhost:3000/c").unwrap(),
            true,
            false,
        ));
        assert!(!caller_allowed(
            "other",
            &url::Url::parse("https://alook.ai/c").unwrap(),
            false,
            false,
        ));
        assert!(!caller_allowed(
            "main",
            &url::Url::parse("https://alook.ai.evil.example/c").unwrap(),
            false,
            false,
        ));
        assert!(!caller_allowed(
            "main",
            &url::Url::parse("https://user@alook.ai/c").unwrap(),
            false,
            false,
        ));
    }

    #[test]
    fn proxy_callers_require_the_main_mobile_development_window() {
        for target in [
            "tauri://localhost/c?view=all",
            "http://tauri.localhost/c",
            "http://tauri.localhost:80/sign-in",
        ] {
            let url = url::Url::parse(target).unwrap();
            for development in [false, true] {
                for mobile in [false, true] {
                    assert_eq!(
                        caller_allowed("main", &url, development, mobile),
                        development && mobile
                    );
                    assert!(!caller_allowed("other", &url, development, mobile));
                }
            }
        }
    }

    #[test]
    fn caller_rejections_preserve_origin_and_build_boundaries() {
        for mobile in [false, true] {
            for development in [false, true] {
                for target in [
                    "tauri://user@localhost/c",
                    "tauri://localhost:80/c",
                    "tauri://localhost.evil.test/c",
                    "http://user:pass@tauri.localhost/c",
                    "http://tauri.localhost:3000/c",
                    "https://tauri.localhost/c",
                    "http://tauri.localhost.evil.test/c",
                    "http://127.0.0.1:3000/c",
                    "http://localhost:3001/c",
                    "http://user@localhost:3000/c",
                    "https://alook.ai:8443/c",
                    "https://user@alook.ai/c",
                    "https://alook.ai.evil.test/c",
                    "alook-recovery://localhost/bootstrap",
                    "http://alook-recovery.localhost/network-error",
                ] {
                    assert!(
                        !caller_allowed(
                            "main",
                            &url::Url::parse(target).unwrap(),
                            development,
                            mobile
                        ),
                        "accepted {target}"
                    );
                }
                assert_eq!(
                    caller_allowed(
                        "main",
                        &url::Url::parse("http://localhost:3000/c").unwrap(),
                        development,
                        mobile
                    ),
                    development
                );
                assert_eq!(
                    caller_allowed(
                        "main",
                        &url::Url::parse("https://alook.ai:443/c").unwrap(),
                        development,
                        mobile
                    ),
                    !development
                );
            }
        }
    }
}
