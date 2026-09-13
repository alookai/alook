use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub permission_state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSnapshot {
    pub installation_id: String,
    pub platform: String,
    pub provider_environment: String,
    pub provider_token: Option<String>,
    pub previous_provider_token: Option<String>,
    pub app_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub notification_id: String,
    pub message_id: String,
    pub target_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MobileSystemNotificationError {
    pub code: String,
    pub message: String,
}

impl MobileSystemNotificationError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn valid_token(value: &str) -> bool {
    (16..=4096).contains(&value.len()) && !value.chars().any(char::is_control)
}

pub fn validate_permission(
    permission: PermissionResponse,
) -> Result<PermissionResponse, MobileSystemNotificationError> {
    if matches!(
        permission.permission_state.as_str(),
        "granted" | "denied" | "prompt"
    ) {
        Ok(permission)
    } else {
        Err(MobileSystemNotificationError::new(
            "invalid_native_response",
            "Native permission state is invalid",
        ))
    }
}

pub fn validate_snapshot(
    snapshot: RegistrationSnapshot,
) -> Result<RegistrationSnapshot, MobileSystemNotificationError> {
    if !uuid(&snapshot.installation_id)
        || !matches!(snapshot.platform.as_str(), "ios" | "android")
        || !matches!(
            snapshot.provider_environment.as_str(),
            "sandbox" | "production"
        )
        || (snapshot.platform == "android" && snapshot.provider_environment != "production")
        || snapshot
            .provider_token
            .as_deref()
            .is_some_and(|token| !valid_token(token))
        || snapshot
            .previous_provider_token
            .as_deref()
            .is_some_and(|token| !valid_token(token))
        || snapshot.previous_provider_token.is_some()
            && snapshot.previous_provider_token == snapshot.provider_token
        || snapshot
            .app_version
            .as_deref()
            .is_some_and(|version| version.is_empty() || version.len() > 128)
    {
        return Err(MobileSystemNotificationError::new(
            "invalid_native_response",
            "Native registration state is invalid",
        ));
    }
    Ok(snapshot)
}

pub fn validate_provider_token(token: &str) -> Result<(), MobileSystemNotificationError> {
    if valid_token(token) {
        Ok(())
    } else {
        Err(MobileSystemNotificationError::new(
            "invalid_request",
            "Provider token is invalid",
        ))
    }
}

pub fn validate_activation(
    activation: Option<Activation>,
) -> Result<Option<Activation>, MobileSystemNotificationError> {
    if let Some(value) = activation.as_ref() {
        if !uuid(&value.notification_id)
            || !safe_id(&value.message_id)
            || !safe_id(&value.target_id)
        {
            return Err(MobileSystemNotificationError::new(
                "invalid_native_response",
                "Native notification route is invalid",
            ));
        }
    }
    Ok(activation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> RegistrationSnapshot {
        RegistrationSnapshot {
            installation_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
            platform: "ios".to_string(),
            provider_environment: "sandbox".to_string(),
            provider_token: Some("0123456789abcdef".to_string()),
            previous_provider_token: None,
            app_version: Some("0.1.36".to_string()),
        }
    }

    #[test]
    fn accepts_only_allowlisted_permission_states() {
        for state in ["granted", "denied", "prompt"] {
            let permission = PermissionResponse {
                permission_state: state.to_string(),
            };
            assert_eq!(
                validate_permission(permission).unwrap().permission_state,
                state
            );
        }

        let error = validate_permission(PermissionResponse {
            permission_state: "unknown".to_string(),
        })
        .unwrap_err();
        assert_eq!(error.code, "invalid_native_response");
    }

    #[test]
    fn accepts_valid_provider_tokens_and_rejects_invalid_values() {
        assert!(validate_provider_token("0123456789abcdef").is_ok());
        assert!(validate_provider_token(&"a".repeat(4096)).is_ok());

        for token in [
            "short".to_string(),
            "0123456789abcde\n".to_string(),
            "a".repeat(4097),
        ] {
            let error = validate_provider_token(&token).unwrap_err();
            assert_eq!(error.code, "invalid_request");
            assert!(!error.message.contains(&token));
        }
    }

    #[test]
    fn accepts_exact_mobile_registration_state() {
        assert!(validate_snapshot(snapshot()).is_ok());
        let mut android = snapshot();
        android.platform = "android".to_string();
        android.provider_environment = "production".to_string();
        android.previous_provider_token = Some("fedcba9876543210".to_string());
        assert!(validate_snapshot(android).is_ok());
    }

    #[test]
    fn rejects_invalid_registration_state_without_echoing_tokens() {
        for mutate in [
            |value: &mut RegistrationSnapshot| value.installation_id = "bad".to_string(),
            |value: &mut RegistrationSnapshot| value.platform = "desktop".to_string(),
            |value: &mut RegistrationSnapshot| value.provider_token = Some("short".to_string()),
            |value: &mut RegistrationSnapshot| {
                value.previous_provider_token = value.provider_token.clone()
            },
        ] {
            let mut value = snapshot();
            mutate(&mut value);
            let error = validate_snapshot(value).unwrap_err();
            assert_eq!(error.code, "invalid_native_response");
            assert!(!error.message.contains("0123456789abcdef"));
        }

        let mut android = snapshot();
        android.platform = "android".to_string();
        assert!(validate_snapshot(android).is_err());
    }

    #[test]
    fn accepts_only_allowlisted_activation_shape_values() {
        let value = Activation {
            notification_id: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e".to_string(),
            message_id: "message_1".to_string(),
            target_id: "channel-2".to_string(),
        };
        assert!(validate_activation(Some(value)).is_ok());
        assert!(validate_activation(None).is_ok());

        let invalid = Activation {
            notification_id: "bad".to_string(),
            message_id: "../message".to_string(),
            target_id: "channel".to_string(),
        };
        assert!(validate_activation(Some(invalid)).is_err());
    }
}
