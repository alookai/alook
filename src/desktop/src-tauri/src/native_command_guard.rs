use tauri::WebviewWindow;

pub fn caller_allowed(label: &str, url: &url::Url, development: bool) -> bool {
    let expected = if development {
        "http://localhost:3000"
    } else {
        "https://alook.ai"
    };
    label == "main"
        && url.origin().ascii_serialization() == expected
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn guard(window: &WebviewWindow) -> Result<(), &'static str> {
    let url = window.url().map_err(|_| "untrusted_caller")?;
    if caller_allowed(window.label(), &url, tauri::is_dev()) {
        Ok(())
    } else {
        Err("untrusted_caller")
    }
}

#[cfg(test)]
mod tests {
    use super::caller_allowed;

    #[test]
    fn proxy_origins_never_grant_command_access() {
        for development in [false, true] {
            for target in [
                "tauri://localhost/c",
                "http://tauri.localhost/c",
                "http://tauri.localhost:80/c",
                "http://localhost:3001/c",
                "http://127.0.0.1:3000/c",
                "http://user@localhost:3000/c",
                "http://user:password@localhost:3000/c",
                "https://alook.ai:8443/c",
                "alook-recovery://localhost/bootstrap",
                "http://alook-recovery.localhost/bootstrap",
            ] {
                let url = url::Url::parse(target).unwrap();
                assert!(
                    !caller_allowed("main", &url, development),
                    "accepted {target}"
                );
                assert!(!caller_allowed("other", &url, development));
            }
        }
    }

    #[test]
    fn accepts_only_the_main_window_and_exact_origin() {
        assert!(caller_allowed(
            "main",
            &url::Url::parse("https://alook.ai/c").unwrap(),
            false,
        ));
        assert!(caller_allowed(
            "main",
            &url::Url::parse("http://localhost:3000/c").unwrap(),
            true,
        ));
        assert!(!caller_allowed(
            "other",
            &url::Url::parse("https://alook.ai/c").unwrap(),
            false,
        ));
        assert!(!caller_allowed(
            "main",
            &url::Url::parse("https://alook.ai.evil.example/c").unwrap(),
            false,
        ));
        assert!(!caller_allowed(
            "main",
            &url::Url::parse("https://user@alook.ai/c").unwrap(),
            false,
        ));
    }
}
