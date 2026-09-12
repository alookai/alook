#[derive(Clone, Debug, thiserror::Error)]
#[error("[{code}] {message}")]
pub struct Error {
    pub code: String,
    pub message: String,
}

impl Error {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "unavailable".to_string(),
            message: message.into(),
        }
    }
}

#[cfg(mobile)]
impl From<tauri::plugin::mobile::PluginInvokeError> for Error {
    fn from(error: tauri::plugin::mobile::PluginInvokeError) -> Self {
        match error {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) => Self {
                code: response.code.unwrap_or_else(|| "native_failed".to_string()),
                message: response
                    .message
                    .unwrap_or_else(|| "Native push operation failed".to_string()),
            },
            other => Self::unavailable(other.to_string()),
        }
    }
}
