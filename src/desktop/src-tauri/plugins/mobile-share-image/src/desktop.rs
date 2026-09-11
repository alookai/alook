use crate::{CopyRequest, Error, ImageResult, SaveRequest};
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<MobileShareImage<R>, Error> {
    Ok(MobileShareImage(std::marker::PhantomData))
}

pub struct MobileShareImage<R: Runtime>(std::marker::PhantomData<R>);

impl<R: Runtime> MobileShareImage<R> {
    pub async fn copy(&self, _request: CopyRequest) -> Result<ImageResult, Error> {
        Err(Error::unavailable("Mobile image actions are unavailable"))
    }

    pub async fn save(&self, _request: SaveRequest) -> Result<ImageResult, Error> {
        Err(Error::unavailable("Mobile image actions are unavailable"))
    }
}
