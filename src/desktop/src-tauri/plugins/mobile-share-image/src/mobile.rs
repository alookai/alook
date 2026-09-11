use crate::{CopyRequest, Error, ImageResult, SaveRequest};
use serde::de::DeserializeOwned;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "ai.alook.plugin.mobileshareimage";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_share_image);

fn monotonic_micros() -> u128 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros()
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<MobileShareImage<R>, Error> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MobileShareImagePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_share_image)?;
    Ok(MobileShareImage(handle))
}

pub struct MobileShareImage<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MobileShareImage<R> {
    pub async fn copy(&self, request: CopyRequest) -> Result<ImageResult, Error> {
        self.run("copyImage", request.attempt_id.clone(), request)
            .await
    }

    pub async fn save(&self, request: SaveRequest) -> Result<ImageResult, Error> {
        self.run("saveImage", request.attempt_id.clone(), request)
            .await
    }

    async fn run<T: serde::Serialize>(
        &self,
        command: &str,
        attempt_id: String,
        request: T,
    ) -> Result<ImageResult, Error> {
        if cfg!(debug_assertions) {
            eprintln!(
                "mobile-share-image plugin-rust dispatch attempt={} t={}",
                attempt_id,
                monotonic_micros()
            );
        }
        let result = self.0.run_mobile_plugin_async(command, request).await;
        if cfg!(debug_assertions) {
            eprintln!(
                "mobile-share-image plugin-rust return attempt={} ok={} t={}",
                attempt_id,
                result.is_ok(),
                monotonic_micros()
            );
        }
        result.map_err(Into::into)
    }
}
