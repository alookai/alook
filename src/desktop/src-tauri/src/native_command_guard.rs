use tauri::WebviewWindow;

pub fn caller_allowed(label: &str, url: &url::Url, debug: bool) -> bool {
    let expected = if debug {
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
    if caller_allowed(window.label(), &url, cfg!(debug_assertions)) {
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
