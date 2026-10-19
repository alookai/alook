use std::{collections::VecDeque, sync::Mutex};

pub const SERVICE_UUID: &str = "b4df5a1c-3f6b-f4bf-ea4a-820304901a02";

#[derive(Default)]
pub struct TouchSetupState(Mutex<Inner>);
#[derive(Default)]
struct Inner {
    generation: u64,
    current: Option<Attempt>,
    retired: VecDeque<String>,
}
struct Attempt {
    id: String,
    ready: bool,
    busy: bool,
}
pub struct Lease<'a> {
    state: &'a TouchSetupState,
    id: String,
    generation: u64,
}

pub fn validate_id(id: &str) -> Result<(), &'static str> {
    if id.len() == 36
        && id.bytes().enumerate().all(|(index, value)| {
            if [8, 13, 18, 23].contains(&index) {
                value == b'-'
            } else {
                value.is_ascii_hexdigit() && !value.is_ascii_uppercase()
            }
        })
    {
        Ok(())
    } else {
        Err("invalid_attempt")
    }
}

pub fn validate_connection(name: &str, pop: &str, service: &str) -> Result<(), &'static str> {
    if name.len() != 18
        || !name.starts_with("ALOOK_TOUCH_")
        || !name[12..]
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'A'..=b'F').contains(&value))
        || pop.len() != 32
        || !pop
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        || service != SERVICE_UUID
    {
        return Err("invalid_setup_code");
    }
    Ok(())
}

pub fn validate_network(ssid: &str, password: &str) -> Result<(), &'static str> {
    if ssid.is_empty()
        || ssid.len() > 32
        || ssid.contains('\0')
        || (!password.is_empty() && !(8..=63).contains(&password.len()))
        || password.contains('\0')
    {
        return Err("invalid_network");
    }
    Ok(())
}

fn valid_code(value: &str) -> bool {
    let separated = value.len() == 9 && value.as_bytes()[4] == b'-';
    (value.len() == 8 || separated)
        && value.bytes().enumerate().all(|(i, c)| {
            if separated && i == 4 {
                true
            } else {
                c.is_ascii_uppercase() || c.is_ascii_digit()
            }
        })
}
pub fn validate_exchange(action: &str, code: Option<&str>) -> Result<(), &'static str> {
    match (action, code) {
        ("code", None) => Ok(()),
        ("ack", Some(value)) if valid_code(value) => Ok(()),
        _ => Err("invalid_exchange"),
    }
}
pub fn validate_grant(response: &str, expected: Option<&str>) -> Result<(), &'static str> {
    if response.len() > 256 {
        return Err("invalid_grant");
    }
    let grant: serde_json::Value = serde_json::from_str(response).map_err(|_| "invalid_grant")?;
    match grant.get("state").and_then(|value| value.as_str()) {
        Some("pending") if expected.is_none() => Ok(()),
        Some("ready") => {
            let code = grant
                .get("user_code")
                .and_then(|value| value.as_str())
                .ok_or("invalid_grant")?;
            if valid_code(code) && expected.is_none_or(|value| value == code) {
                Ok(())
            } else {
                Err("invalid_grant")
            }
        }
        _ => Err("invalid_grant"),
    }
}

impl Inner {
    fn remember(&mut self, id: &str) {
        if !self.retired.iter().any(|value| value == id) {
            self.retired.push_back(id.to_owned());
        }
        if self.retired.len() > 256 {
            self.retired.pop_front();
        }
    }
}
impl TouchSetupState {
    pub fn begin(&self, id: &str) -> Result<Lease<'_>, &'static str> {
        validate_id(id)?;
        let mut inner = self.0.lock().map_err(|_| "setup_unavailable")?;
        if inner.retired.iter().any(|value| value == id) {
            return Err("setup_retired");
        }
        if inner
            .current
            .as_ref()
            .is_some_and(|attempt| attempt.id == id)
        {
            return Err("setup_busy");
        }
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(previous) = inner.current.take() {
            inner.remember(&previous.id);
        }
        inner.current = Some(Attempt {
            id: id.to_owned(),
            ready: false,
            busy: true,
        });
        Ok(Lease {
            state: self,
            id: id.to_owned(),
            generation: inner.generation,
        })
    }
    pub fn acquire(&self, id: &str) -> Result<Lease<'_>, &'static str> {
        validate_id(id)?;
        let mut inner = self.0.lock().map_err(|_| "setup_unavailable")?;
        let attempt = inner
            .current
            .as_mut()
            .filter(|attempt| attempt.id == id)
            .ok_or("setup_retired")?;
        if !attempt.ready || attempt.busy {
            return Err("setup_busy");
        }
        attempt.busy = true;
        Ok(Lease {
            state: self,
            id: id.to_owned(),
            generation: inner.generation,
        })
    }
    pub fn cancel(&self, id: &str) -> Result<(), &'static str> {
        validate_id(id)?;
        let mut inner = self.0.lock().map_err(|_| "setup_unavailable")?;
        inner.remember(id);
        if inner
            .current
            .as_ref()
            .is_some_and(|attempt| attempt.id == id)
        {
            inner.current = None;
            inner.generation = inner.generation.wrapping_add(1);
        }
        Ok(())
    }
    pub fn retire(&self) -> Option<String> {
        let mut inner = self.0.lock().ok()?;
        inner.generation = inner.generation.wrapping_add(1);
        let id = inner.current.take().map(|attempt| attempt.id);
        if let Some(id) = &id {
            inner.remember(id);
        }
        id
    }
}
impl Lease<'_> {
    pub fn check(&self) -> Result<(), &'static str> {
        let inner = self.state.0.lock().map_err(|_| "setup_unavailable")?;
        if inner.generation == self.generation
            && inner
                .current
                .as_ref()
                .is_some_and(|attempt| attempt.id == self.id)
        {
            Ok(())
        } else {
            Err("setup_retired")
        }
    }
    pub fn connected(&self) -> Result<(), &'static str> {
        let mut inner = self.state.0.lock().map_err(|_| "setup_unavailable")?;
        if inner.generation != self.generation {
            return Err("setup_retired");
        }
        let attempt = inner
            .current
            .as_mut()
            .filter(|attempt| attempt.id == self.id)
            .ok_or("setup_retired")?;
        attempt.ready = true;
        Ok(())
    }
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.state.0.lock() {
            if inner.generation == self.generation {
                if let Some(attempt) = inner
                    .current
                    .as_mut()
                    .filter(|attempt| attempt.id == self.id)
                {
                    attempt.busy = false;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIRST: &str = "11111111-1111-4111-8111-111111111111";
    const NEXT: &str = "22222222-2222-4222-8222-222222222222";
    #[test]
    fn old_result_and_cancel_cannot_retire_new_attempt() {
        let state = TouchSetupState::default();
        let old = state.begin(FIRST).unwrap();
        state.cancel(FIRST).unwrap();
        let next = state.begin(NEXT).unwrap();
        assert_eq!(old.connected(), Err("setup_retired"));
        drop(old);
        state.cancel(FIRST).unwrap();
        next.connected().unwrap();
        drop(next);
        let command = state.acquire(NEXT).unwrap();
        assert_eq!(state.acquire(NEXT).err(), Some("setup_busy"));
        assert_eq!(state.retire().as_deref(), Some(NEXT));
        assert_eq!(command.check(), Err("setup_retired"));
    }
    #[test]
    fn new_connection_supersedes_unfinished_connect_and_serializes_commands() {
        let state = TouchSetupState::default();
        let old = state.begin(FIRST).unwrap();
        let next = state.begin(NEXT).unwrap();
        assert_eq!(old.check(), Err("setup_retired"));
        assert_eq!(state.acquire(NEXT).err(), Some("setup_busy"));
        next.connected().unwrap();
        drop(next);
        drop(old);
        drop(state.acquire(NEXT).unwrap());
        assert!(state.acquire(NEXT).is_ok());
    }
    #[test]
    fn cancellation_before_connect_is_not_resurrected_by_late_dispatch() {
        let state = TouchSetupState::default();
        state.cancel(FIRST).unwrap();
        assert_eq!(state.begin(FIRST).err(), Some("setup_retired"));
        let next = state.begin(NEXT).unwrap();
        next.connected().unwrap();
        drop(next);
        state.cancel(FIRST).unwrap();
        assert_eq!(state.begin(FIRST).err(), Some("setup_retired"));
        assert!(state.acquire(NEXT).is_ok());
    }
    #[test]
    fn only_the_current_acknowledged_code_can_enter_review() {
        for code in ["ABCD2345", "ABCD-2345"] {
            validate_exchange("ack", Some(code)).unwrap();
            let response = serde_json::json!({ "state": "ready", "user_code": code }).to_string();
            validate_grant(&response, Some(code)).unwrap();
        }
        for code in [
            "ABCDEFG",
            "ABCDEFGHI",
            "ABC-23456",
            "ABCD--2345",
            "abcd2345",
            "ABCD2345\n",
            "ＡBCD2345",
        ] {
            assert!(validate_exchange("ack", Some(code)).is_err());
            let response = serde_json::json!({ "state": "ready", "user_code": code }).to_string();
            assert!(validate_grant(&response, None).is_err());
        }
        assert!(validate_grant(
            r#"{"state":"ready","user_code":"ABCD2345"}"#,
            Some("ABCD-2345")
        )
        .is_err());
        assert!(validate_exchange("ack", None).is_err());
        assert!(validate_exchange("code", Some("ABCD-1234")).is_err());
        validate_exchange("ack", Some("ABCD-1234")).unwrap();
        validate_grant(r#"{"state":"pending"}"#, None).unwrap();
        assert!(validate_grant(r#"{"state":"pending"}"#, Some("ABCD-1234")).is_err());
        assert!(validate_grant(
            r#"{"state":"ready","user_code":"ABCD-1234"}"#,
            Some("WXYZ-5678")
        )
        .is_err());
        validate_grant(
            r#"{"state":"ready","user_code":"ABCD-1234"}"#,
            Some("ABCD-1234"),
        )
        .unwrap();
    }
    #[test]
    fn bounds_are_bytes_and_reject_untrusted_identifiers() {
        validate_connection(
            "ALOOK_TOUCH_A1B2C3",
            "0123456789abcdef0123456789abcdef",
            SERVICE_UUID,
        )
        .unwrap();
        assert!(validate_connection("ALOOK_TOUCH_A1B2C3", "", SERVICE_UUID).is_err());
        assert!(validate_connection(
            "ALOOK_TOUCH_A1B2C3",
            "0123456789abcdef0123456789abcdef",
            "other"
        )
        .is_err());
        assert!(validate_id("x").is_err());
        assert!(validate_network(&"中".repeat(11), "password").is_err());
        assert!(validate_network("network", "short").is_err());
        assert!(validate_network("network", "").is_ok());
    }
}
