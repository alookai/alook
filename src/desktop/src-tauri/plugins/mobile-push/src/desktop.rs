use crate::{Activation, Error, PermissionResponse, RegistrationSnapshot};
use serde::de::DeserializeOwned;
use tauri::{ipc::Channel, plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<MobilePush<R>, Error> {
    Ok(MobilePush(std::marker::PhantomData))
}

pub struct MobilePush<R: Runtime>(std::marker::PhantomData<R>);

impl<R: Runtime> MobilePush<R> {
    pub async fn check_permissions(&self) -> Result<PermissionResponse, Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }

    pub async fn request_permissions(&self) -> Result<PermissionResponse, Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }

    pub async fn snapshot(&self) -> Result<RegistrationSnapshot, Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }

    pub async fn acknowledge_registration(&self, _provider_token: String) -> Result<(), Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }

    pub async fn take_activation(&self) -> Result<Option<Activation>, Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }

    pub async fn listen(&self, _channel: Channel<()>) -> Result<u64, Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }

    pub async fn unlisten(&self, _registration_id: u64) -> Result<(), Error> {
        Err(Error::unavailable("Mobile push is unavailable"))
    }
}
