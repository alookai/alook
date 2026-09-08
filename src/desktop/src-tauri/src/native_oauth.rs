use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const ATTEMPT_TTL: u64 = 10 * 60 * 1000;
const CANDIDATE_TTL: u64 = 2 * 60 * 1000;
const MAX_CANDIDATES: usize = 8;

fn random_secret() -> Result<String, &'static str> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "random_unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn challenge(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn token(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn safe_candidate(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains(['\\', '#'])
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn decode(value: &str) -> Option<String> {
    let mut result = Vec::new();
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            result.push((high * 16 + low) as u8);
        } else {
            result.push(b);
        }
    }
    String::from_utf8(result).ok()
}

pub fn safe_redirect(value: &str) -> bool {
    if value.len() > 2048 || !safe_candidate(value) {
        return false;
    }
    let mut current = value.to_string();
    for depth in 0..8 {
        let Some(next) = decode(&current) else {
            return depth > 0;
        };
        if next == current {
            break;
        }
        if !safe_candidate(&next) {
            return false;
        }
        current = next;
        if depth == 7 {
            return false;
        }
    }
    let base = url::Url::parse("https://alook.invalid").unwrap();
    base.join(value).is_ok_and(|u| u.origin() == base.origin())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    id: String,
    code: Option<String>,
    status: Option<String>,
    expires_at: u64,
    dispatched: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    id: String,
    state: String,
    verifier: String,
    provider: String,
    redirect_path: String,
    expires_at: u64,
    waiting: bool,
    candidates: Vec<Candidate>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    version: u8,
    owner_key: String,
    attempt: Option<Attempt>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub attempt_id: String,
    state_hash: String,
    code_challenge: String,
    instance_key_hash: String,
    provider: String,
    platform: String,
    redirect_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub attempt_id: String,
    provider: String,
    redirect_path: String,
    expires_at: u64,
    waiting: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    attempt_id: String,
    state: String,
    verifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    #[serde(flatten)]
    proof: Proof,
    candidate_id: String,
    code: Option<String>,
    status: Option<String>,
    was_dispatched: bool,
}

fn allowed_status(value: &str) -> bool {
    matches!(
        value,
        "access_denied"
            | "provider_error"
            | "oauth_callback_failed"
            | "start_failed"
            | "invalid_handoff"
    )
}

fn parse_callback(
    serialized: &str,
    platform: &str,
) -> Option<(String, Option<String>, Option<String>)> {
    if serialized.len() > 512 {
        return None;
    }
    let query = match platform {
        "macos" | "windows" | "linux" => {
            serialized.strip_prefix("ai.alook.desktop://auth/native/return?")
        }
        "ios" | "android" => serialized
            .strip_prefix("https://auth.alook.ai/auth/native/return?")
            .or_else(|| serialized.strip_prefix("ai.alook://auth/native/return?")),
        _ => None,
    }?;
    let mut attempt = None;
    let mut code = None;
    let mut status = None;
    let mut count = 0;
    for pair in query.split('&') {
        count += 1;
        let (key, value) = pair.split_once('=')?;
        match key {
            "attempt" if attempt.is_none() && token(value, 22, 64) => {
                attempt = Some(value.to_string())
            }
            "code" if code.is_none() && token(value, 32, 128) => code = Some(value.to_string()),
            "status" if status.is_none() && allowed_status(value) => {
                status = Some(value.to_string())
            }
            _ => return None,
        }
    }
    if count != 2 || code.is_some() == status.is_some() {
        return None;
    }
    Some((attempt?, code, status))
}

pub fn valid_start(raw: &str, attempt: &str, debug: bool) -> bool {
    let origin = if debug {
        "http://localhost:3000"
    } else {
        "https://alook.ai"
    };
    token(attempt, 22, 64) && raw == format!("{origin}/auth/native/start?attempt={attempt}")
}

impl Record {
    pub fn new() -> Result<Self, &'static str> {
        Ok(Self {
            version: 1,
            owner_key: random_secret()?,
            attempt: None,
        })
    }

    pub fn restore(value: serde_json::Value, now: u64) -> Result<Self, &'static str> {
        let mut record: Self = serde_json::from_value(value).map_err(|_| "invalid_store")?;
        if record.version != 1 || !token(&record.owner_key, 43, 43) {
            return Err("invalid_store");
        }
        if let Some(a) = &record.attempt {
            if !token(&a.id, 43, 43)
                || !token(&a.state, 43, 43)
                || !token(&a.verifier, 43, 43)
                || !matches!(a.provider.as_str(), "github" | "google" | "apple")
                || !safe_redirect(&a.redirect_path)
                || a.expires_at > now.saturating_add(ATTEMPT_TTL)
                || a.candidates.len() > MAX_CANDIDATES
                || a.candidates.iter().any(|c| {
                    !token(&c.id, 43, 43)
                        || c.code.is_some() == c.status.is_some()
                        || c.code.as_ref().is_some_and(|v| !token(v, 32, 128))
                        || c.status.as_ref().is_some_and(|v| !allowed_status(v))
                        || c.expires_at > a.expires_at
                        || c.expires_at > now.saturating_add(CANDIDATE_TTL)
                })
            {
                return Err("invalid_store");
            }
        }
        record.cleanup(now);
        Ok(record)
    }

    pub fn cleanup(&mut self, now: u64) {
        if self.attempt.as_ref().is_some_and(|a| a.expires_at <= now) {
            self.attempt = None;
        }
        if let Some(a) = &mut self.attempt {
            a.candidates.retain(|c| c.expires_at > now);
        }
    }

    pub fn prepare(
        &mut self,
        provider: &str,
        redirect_path: &str,
        platform: &str,
        now: u64,
    ) -> Result<Registration, &'static str> {
        if !matches!(provider, "github" | "google" | "apple")
            || !safe_redirect(redirect_path)
            || !matches!(platform, "macos" | "windows" | "linux" | "ios" | "android")
        {
            return Err("invalid_request");
        }
        let a = Attempt {
            id: random_secret()?,
            state: random_secret()?,
            verifier: random_secret()?,
            provider: provider.into(),
            redirect_path: redirect_path.into(),
            expires_at: now + ATTEMPT_TTL,
            waiting: false,
            candidates: Vec::new(),
        };
        let registration = Registration {
            attempt_id: a.id.clone(),
            state_hash: hash(&a.state),
            code_challenge: challenge(&a.verifier),
            instance_key_hash: hash(&self.owner_key),
            provider: provider.into(),
            platform: platform.into(),
            redirect_path: redirect_path.into(),
        };
        self.attempt = Some(a);
        Ok(registration)
    }

    pub fn snapshot(&self) -> Option<Snapshot> {
        self.attempt.as_ref().map(|a| Snapshot {
            attempt_id: a.id.clone(),
            provider: a.provider.clone(),
            redirect_path: a.redirect_path.clone(),
            expires_at: a.expires_at,
            waiting: a.waiting,
        })
    }

    pub fn open(
        &mut self,
        attempt_id: &str,
        start_url: &str,
        debug: bool,
    ) -> Result<(), &'static str> {
        let a = self.attempt.as_mut().ok_or("no_attempt")?;
        if !equal(&a.id, attempt_id) || a.waiting || !valid_start(start_url, attempt_id, debug) {
            return Err("invalid_start");
        }
        a.waiting = true;
        Ok(())
    }

    pub fn intake(&mut self, url: &url::Url, now: u64) -> Result<bool, &'static str> {
        self.intake_for_platform(url, now, std::env::consts::OS)
    }

    fn intake_for_platform(
        &mut self,
        url: &url::Url,
        now: u64,
        platform: &str,
    ) -> Result<bool, &'static str> {
        let Some((id, code, status)) = parse_callback(url.as_str(), platform) else {
            return Ok(false);
        };
        let Some(a) = self.attempt.as_mut() else {
            return Ok(false);
        };
        if !equal(&a.id, &id) || !a.waiting || a.expires_at <= now {
            return Ok(false);
        }
        if a.candidates
            .iter()
            .any(|c| c.code == code && c.status == status)
        {
            return Ok(false);
        }
        if a.candidates.len() >= MAX_CANDIDATES {
            return Ok(false);
        }
        a.candidates.push(Candidate {
            id: random_secret()?,
            code,
            status,
            expires_at: (now + CANDIDATE_TTL).min(a.expires_at),
            dispatched: false,
        });
        Ok(true)
    }

    pub fn pending(&mut self) -> Option<Exchange> {
        let a = self.attempt.as_mut()?;
        let c = a.candidates.first_mut()?;
        let result = Exchange {
            proof: Proof {
                attempt_id: a.id.clone(),
                state: a.state.clone(),
                verifier: a.verifier.clone(),
            },
            candidate_id: c.id.clone(),
            code: c.code.clone(),
            status: c.status.clone(),
            was_dispatched: c.dispatched,
        };
        c.dispatched = true;
        Some(result)
    }

    pub fn reject(&mut self, attempt_id: &str, candidate_id: &str) {
        if let Some(a) = self.attempt.as_mut().filter(|a| equal(&a.id, attempt_id)) {
            a.candidates.retain(|c| !equal(&c.id, candidate_id));
        }
    }

    pub fn finish(&mut self, attempt_id: &str, candidate_id: &str) {
        if self.attempt.as_ref().is_some_and(|a| {
            equal(&a.id, attempt_id) && a.candidates.iter().any(|c| equal(&c.id, candidate_id))
        }) {
            self.attempt = None;
        }
    }

    pub fn cancel(&mut self, attempt_id: &str) -> Result<Option<Proof>, &'static str> {
        if !self
            .attempt
            .as_ref()
            .is_some_and(|a| equal(&a.id, attempt_id))
        {
            return Ok(None);
        }
        let owner_key = random_secret()?;
        let a = self.attempt.take().unwrap();
        self.owner_key = owner_key;
        Ok(Some(Proof {
            attempt_id: a.id,
            state: a.state,
            verifier: a.verifier,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: u64 = 1_000_000;
    fn waiting() -> Record {
        let mut r = Record::new().unwrap();
        let p = r.prepare("github", "/c/me?one=1", "macos", NOW).unwrap();
        r.open(
            &p.attempt_id,
            &format!(
                "https://alook.ai/auth/native/start?attempt={}",
                p.attempt_id
            ),
            false,
        )
        .unwrap();
        r
    }
    fn callback(r: &Record, value: &str) -> String {
        format!(
            "ai.alook.desktop://auth/native/return?attempt={}&code={value}",
            r.attempt.as_ref().unwrap().id
        )
    }
    #[test]
    fn pkce_and_registration_keep_secrets_native() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let mut r = Record::new().unwrap();
        let p = r.prepare("github", "/c/me", "macos", NOW).unwrap();
        let json = serde_json::to_string(&p).unwrap();
        let a = r.attempt.as_ref().unwrap();
        for secret in [&a.state, &a.verifier, &r.owner_key] {
            assert!(!json.contains(secret));
        }
        assert_ne!(a.state, a.verifier);
        let old_id = p.attempt_id;
        let next = r.prepare("google", "/c/me", "windows", NOW).unwrap();
        assert_eq!(p.instance_key_hash, next.instance_key_hash);
        assert_ne!(old_id, next.attempt_id);
        r.cancel(&next.attempt_id).unwrap();
        let next = r.prepare("google", "/c/me", "linux", NOW).unwrap();
        assert_ne!(p.instance_key_hash, next.instance_key_hash);
    }
    #[test]
    fn redirects_match_the_shared_nested_decode_contract() {
        for path in ["/c/me", "/c/me?tab=hello%20world", "/c?x=%25", "/%E4%B8%AD"] {
            assert!(safe_redirect(path), "{path}");
        }
        for path in [
            "https://evil.test",
            "//evil",
            "/\\evil",
            "/a#b",
            "/%5cevil",
            "/%252f%252fevil",
            "/x\n",
            "/%00",
            "/%zz",
        ] {
            assert!(!safe_redirect(path), "{path}");
        }
        assert!(!safe_redirect(&format!("/{}", "a".repeat(2048))));
    }
    #[test]
    fn serialized_callback_parser_rejects_noncanonical_direct_input() {
        let r = waiting();
        let good = callback(&r, &"c".repeat(32));
        assert!(parse_callback(&good, "macos").is_some());
        for bad in [
            format!("{good}&x=1"),
            format!("{good}&status=access_denied"),
            format!("{good}#fragment"),
            good.replace("//auth/", "//user@auth/"),
            good.replace("/native/", "/x/../native/"),
            good.replace("attempt=", "attempt=x&attempt="),
            good.replace("code=", "code=&code="),
            good.replace("ai.alook.desktop", "ai.alook"),
            good.replace("code=", "c%6fde="),
        ] {
            assert!(parse_callback(&bad, "macos").is_none());
        }
    }
    #[test]
    fn parsed_callback_intake_accepts_canonical_paths_and_deduplicates_aliases() {
        let original = waiting();
        let good = callback(&original, &"c".repeat(32));
        let aliases = [
            good.clone(),
            good.replace("/native/", "/x/../native/"),
            good.replace("/native/", "/%2e/native/"),
        ];
        for raw in &aliases {
            let url = url::Url::parse(raw).unwrap();
            assert_eq!(url.as_str(), good);
            let mut record = original.clone();
            assert!(record.intake(&url, NOW).unwrap());
            assert_eq!(
                record.pending().unwrap().code.as_deref(),
                Some("c".repeat(32).as_str())
            );
        }
        let mut record = original;
        for (index, raw) in aliases.iter().enumerate() {
            assert_eq!(
                record.intake(&url::Url::parse(raw).unwrap(), NOW).unwrap(),
                index == 0
            );
        }
        assert_eq!(record.attempt.as_ref().unwrap().candidates.len(), 1);
        let status = good.replace(&format!("code={}", "c".repeat(32)), "status=access_denied");
        assert!(record
            .intake(&url::Url::parse(&status).unwrap(), NOW)
            .unwrap());
        assert_eq!(record.attempt.as_ref().unwrap().candidates.len(), 2);
    }

    #[test]
    fn parsed_callback_intake_rejects_invalid_identity_query_and_attempt_without_mutation() {
        let mut record = waiting();
        let good = callback(&record, &"c".repeat(32));
        assert!(record
            .intake(&url::Url::parse(&good).unwrap(), NOW)
            .unwrap());
        let before = serde_json::to_value(&record).unwrap();
        let id = &record.attempt.as_ref().unwrap().id;
        for raw in [
            good.replace("ai.alook.desktop:", "ai.alook:"),
            good.replace("//auth/", "//evil/"),
            good.replace("//auth/", "//auth.evil/"),
            good.replace("//auth/", "//user@auth/"),
            good.replace("//auth/", "//auth:443/"),
            good.replace("/native/return", "/native/other"),
            good.replace("/native/return", "/%6eative/return"),
            format!("{good}#fragment"),
            format!("{good}#"),
            format!("{good}&extra=1"),
            format!("{good}&attempt={id}"),
            format!("{good}&code={}", "d".repeat(32)),
            format!("{good}&status=access_denied"),
            good.replace("attempt=", "att%65mpt="),
            good.replace("code=", "c%6fde="),
            good.replace(&"c".repeat(32), "%63"),
            good.replace(&"c".repeat(32), &"c".repeat(129)),
            good.replace(&format!("&code={}", "c".repeat(32)), ""),
            good.replace(&format!("code={}", "c".repeat(32)), "status=unknown"),
            good.replace(id, &"x".repeat(43)),
        ] {
            let url = url::Url::parse(&raw).unwrap();
            assert!(!record.intake(&url, NOW).unwrap());
            assert_eq!(serde_json::to_value(&record).unwrap(), before);
        }
        let next = url::Url::parse(&good.replace(&"c".repeat(32), &"d".repeat(32))).unwrap();
        assert!(!record.intake(&next, NOW + ATTEMPT_TTL).unwrap());
        assert_eq!(serde_json::to_value(&record).unwrap(), before);
    }

    #[test]
    fn callback_length_bound_applies_to_serialized_url() {
        let mut record = waiting();
        let good = callback(&record, &"c".repeat(32));
        let raw = good.replace("/native/", &format!("/{}../native/", "x".repeat(600) + "/"));
        assert!(raw.len() > 512);
        let url = url::Url::parse(&raw).unwrap();
        assert_eq!(url.as_str(), good);
        assert!(record.intake(&url, NOW).unwrap());
        let before = serde_json::to_value(&record).unwrap();
        let oversized = url::Url::parse(&format!("{good}&extra={}", "x".repeat(512))).unwrap();
        assert!(oversized.as_str().len() > 512);
        assert!(!record.intake(&oversized, NOW).unwrap());
        assert_eq!(serde_json::to_value(&record).unwrap(), before);
    }

    #[test]
    fn queue_is_bounded_deduplicated_and_wrong_candidate_cannot_delete_attempt() {
        let mut r = waiting();
        for i in 0..10 {
            let raw = callback(&r, &format!("{i:032}"));
            assert_eq!(
                r.intake(&url::Url::parse(&raw).unwrap(), NOW).unwrap(),
                i < 8
            );
        }
        let raw = callback(&r, &format!("{:032}", 0));
        assert!(!r.intake(&url::Url::parse(&raw).unwrap(), NOW).unwrap());
        let first = r.pending().unwrap();
        assert!(!first.was_dispatched);
        assert!(r.pending().unwrap().was_dispatched);
        r.reject("old", &first.candidate_id);
        assert_eq!(r.attempt.as_ref().unwrap().candidates.len(), 8);
        r.reject(&first.proof.attempt_id, &first.candidate_id);
        assert_eq!(r.attempt.as_ref().unwrap().candidates.len(), 7);
        assert_eq!(
            r.pending().unwrap().code.as_deref(),
            Some(format!("{:032}", 1).as_str())
        );
        assert!(r.snapshot().is_some());
    }
    #[test]
    fn cold_reload_expiry_and_corruption_fail_closed() {
        let mut r = waiting();
        let raw = callback(&r, &"c".repeat(32));
        r.intake(&url::Url::parse(&raw).unwrap(), NOW).unwrap();
        let first = r.pending().unwrap();
        let stored = serde_json::to_value(&r).unwrap();
        let mut restored = Record::restore(stored.clone(), NOW + 1).unwrap();
        assert!(restored.pending().unwrap().was_dispatched);
        restored.cleanup(NOW + CANDIDATE_TTL);
        assert!(restored.pending().is_none());
        assert!(restored.snapshot().is_some());
        restored.cleanup(NOW + ATTEMPT_TTL);
        assert!(restored.snapshot().is_none());
        let mut corrupt = stored;
        corrupt["version"] = 2.into();
        assert!(Record::restore(corrupt, NOW).is_err());
        assert!(Record::restore(serde_json::json!({"version":1}), NOW).is_err());
        r.finish(&first.proof.attempt_id, &first.candidate_id);
        assert!(r.snapshot().is_none());
    }
    #[test]
    fn replacement_cancel_and_old_completion_are_isolated() {
        let mut r = waiting();
        let raw = callback(&r, &"c".repeat(32));
        r.intake(&url::Url::parse(&raw).unwrap(), NOW).unwrap();
        let old = r.pending().unwrap();
        let new = r.prepare("google", "/c/me", "linux", NOW).unwrap();
        assert!(!r.intake(&url::Url::parse(&raw).unwrap(), NOW).unwrap());
        r.finish(&old.proof.attempt_id, &old.candidate_id);
        assert!(r.cancel(&old.proof.attempt_id).unwrap().is_none());
        let proof = r.cancel(&new.attempt_id).unwrap().unwrap();
        assert_eq!(proof.attempt_id, new.attempt_id);
        assert!(r.snapshot().is_none());
        assert!(r.cancel(&new.attempt_id).unwrap().is_none());
    }
    #[test]
    fn authenticated_cleanup_requires_current_attempt_and_survives_candidate_expiry() {
        let mut r = waiting();
        let raw = callback(&r, &"c".repeat(32));
        r.intake(&url::Url::parse(&raw).unwrap(), NOW).unwrap();
        let attempt_id = r.attempt.as_ref().unwrap().id.clone();
        let original_owner = r.owner_key.clone();
        let unchanged = serde_json::to_value(&r).unwrap();

        assert!(r.cancel("stale-attempt").unwrap().is_none());
        assert_eq!(serde_json::to_value(&r).unwrap(), unchanged);

        r.cleanup(NOW + CANDIDATE_TTL);
        assert!(r.attempt.as_ref().unwrap().candidates.is_empty());
        assert!(r.snapshot().is_some());

        let proof = r.cancel(&attempt_id).unwrap().unwrap();
        assert_eq!(proof.attempt_id, attempt_id);
        assert!(r.snapshot().is_none());
        assert_ne!(r.owner_key, original_owner);
        let rotated_owner = r.owner_key.clone();

        assert!(r.cancel(&attempt_id).unwrap().is_none());
        assert_eq!(r.owner_key, rotated_owner);
    }
    #[test]
    fn open_requires_current_unopened_attempt_and_fixed_build_origin() {
        let mut r = Record::new().unwrap();
        let p = r.prepare("github", "/c/me", "macos", NOW).unwrap();
        let good = format!(
            "https://alook.ai/auth/native/start?attempt={}",
            p.attempt_id
        );
        assert!(!valid_start(&good, &p.attempt_id, true));
        for url in [
            format!("{good}&extra=1"),
            good.replace("alook.ai", "evil.test"),
            format!("{good}#x"),
        ] {
            assert!(!valid_start(&url, &p.attempt_id, false));
        }
        assert!(r.open("old", &good, false).is_err());
        r.open(&p.attempt_id, &good, false).unwrap();
        assert!(r.open(&p.attempt_id, &good, false).is_err());
        assert!(r.prepare("apple", "/c/me", "macos", NOW).is_ok());
        assert!(r.prepare("google", "/c/me", "ios", NOW).is_ok());
        assert!(r.prepare("google", "/c/me", "android", NOW).is_ok());
        assert!(r.prepare("google", "/c/me", "web", NOW).is_err());
        assert!(r.prepare("twitter", "/c/me", "macos", NOW).is_err());
    }

    #[test]
    fn apple_uses_the_existing_bridge_on_all_five_platforms() {
        for platform in ["macos", "windows", "linux", "ios", "android"] {
            let mut record = Record::new().unwrap();
            let registration = record.prepare("apple", "/c/me", platform, NOW).unwrap();
            assert_eq!(registration.provider, "apple");
            assert_eq!(record.snapshot().unwrap().provider, "apple");
        }
    }

    #[test]
    fn mobile_callbacks_accept_only_exact_primary_and_fallback_identities() {
        for platform in ["ios", "android"] {
            let mut record = Record::new().unwrap();
            let attempt = record.prepare("github", "/c/me", platform, NOW).unwrap();
            record
                .open(
                    &attempt.attempt_id,
                    &format!(
                        "https://alook.ai/auth/native/start?attempt={}",
                        attempt.attempt_id
                    ),
                    false,
                )
                .unwrap();
            for prefix in [
                "https://auth.alook.ai/auth/native/return",
                "ai.alook://auth/native/return",
            ] {
                let raw = format!(
                    "{prefix}?attempt={}&code={}",
                    attempt.attempt_id,
                    "c".repeat(32)
                );
                let mut candidate = record.clone();
                assert!(candidate
                    .intake_for_platform(&url::Url::parse(&raw).unwrap(), NOW, platform)
                    .unwrap());
            }
            let before = serde_json::to_value(&record).unwrap();
            for raw in [
                format!(
                    "http://auth.alook.ai/auth/native/return?attempt={}&code={}",
                    attempt.attempt_id,
                    "c".repeat(32)
                ),
                format!(
                    "https://auth.alook.ai:8443/auth/native/return?attempt={}&code={}",
                    attempt.attempt_id,
                    "c".repeat(32)
                ),
                format!(
                    "https://user@auth.alook.ai/auth/native/return?attempt={}&code={}",
                    attempt.attempt_id,
                    "c".repeat(32)
                ),
                format!(
                    "ai.alook.desktop://auth/native/return?attempt={}&code={}",
                    attempt.attempt_id,
                    "c".repeat(32)
                ),
                format!(
                    "ai.alook://auth/auth/native/return?attempt={}&code={}",
                    attempt.attempt_id,
                    "c".repeat(32)
                ),
            ] {
                assert!(!record
                    .intake_for_platform(&url::Url::parse(&raw).unwrap(), NOW, platform)
                    .unwrap());
                assert_eq!(serde_json::to_value(&record).unwrap(), before);
            }
        }
    }

    #[test]
    fn desktop_rejects_mobile_callback_identities() {
        let mut record = waiting();
        let id = record.attempt.as_ref().unwrap().id.clone();
        for prefix in [
            "https://auth.alook.ai/auth/native/return",
            "ai.alook://auth/native/return",
        ] {
            let raw = format!("{prefix}?attempt={id}&code={}", "c".repeat(32));
            assert!(!record
                .intake_for_platform(&url::Url::parse(&raw).unwrap(), NOW, "macos")
                .unwrap());
        }
    }
}
