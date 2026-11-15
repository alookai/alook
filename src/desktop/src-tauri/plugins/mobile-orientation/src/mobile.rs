use crate::{Error, ListenRequest, StopRequest};
use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_orientation);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<MobileOrientation<R>, Error> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "ai.alook.plugin.mobileorientation",
        "MobileOrientationPlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_orientation)?;
    Ok(MobileOrientation(handle))
}

pub struct MobileOrientation<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MobileOrientation<R> {
    pub async fn listen(&self, request: ListenRequest) -> Result<(), Error> {
        self.0
            .run_mobile_plugin_async("listen", request)
            .await
            .map_err(Into::into)
    }
    pub async fn unlisten(&self, registration_id: u64) -> Result<(), Error> {
        self.0
            .run_mobile_plugin_async("unlisten", StopRequest { registration_id })
            .await
            .map_err(Into::into)
    }
    pub async fn retire(&self, registration_id: u64) -> Result<(), Error> {
        self.0
            .run_mobile_plugin_async("retire", StopRequest { registration_id })
            .await
            .map_err(Into::into)
    }
}
