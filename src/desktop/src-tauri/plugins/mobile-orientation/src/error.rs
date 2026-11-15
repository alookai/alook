#[derive(Clone, Debug, thiserror::Error)]
#[error("Mobile orientation is unavailable")]
pub struct Error;

#[cfg(mobile)]
impl From<tauri::plugin::mobile::PluginInvokeError> for Error {
    fn from(_: tauri::plugin::mobile::PluginInvokeError) -> Self {
        Self
    }
}
