use crate::{
    AcknowledgeRequest, Activation, Error, ListenRequest, PermissionResponse, RegistrationSnapshot,
    UnlistenRequest,
};
use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel,
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "ai.alook.plugin.mobilepush";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_push);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<MobilePush<R>, Error> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MobilePushPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_push)?;
    Ok(MobilePush(handle))
}

pub struct MobilePush<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MobilePush<R> {
    pub async fn check_permissions(&self) -> Result<PermissionResponse, Error> {
        self.0
            .run_mobile_plugin_async("checkPermissions", ())
            .await
            .map_err(Into::into)
    }

    pub async fn request_permissions(&self) -> Result<PermissionResponse, Error> {
        self.0
            .run_mobile_plugin_async("requestPermissions", ())
            .await
            .map_err(Into::into)
    }

    pub async fn snapshot(&self) -> Result<RegistrationSnapshot, Error> {
        self.0
            .run_mobile_plugin_async("snapshot", ())
            .await
            .map_err(Into::into)
    }

    pub async fn acknowledge_registration(&self, provider_token: String) -> Result<(), Error> {
        self.0
            .run_mobile_plugin_async(
                "acknowledgeRegistration",
                AcknowledgeRequest { provider_token },
            )
            .await
            .map_err(Into::into)
    }

    pub async fn take_activation(&self) -> Result<Option<Activation>, Error> {
        self.0
            .run_mobile_plugin_async("takeActivation", ())
            .await
            .map_err(Into::into)
    }

    pub async fn listen(&self, channel: Channel<()>) -> Result<u64, Error> {
        self.0
            .run_mobile_plugin_async("listen", ListenRequest { channel })
            .await
            .map_err(Into::into)
    }

    pub async fn unlisten(&self, registration_id: u64) -> Result<(), Error> {
        self.0
            .run_mobile_plugin_async("unlisten", UnlistenRequest { registration_id })
            .await
            .map_err(Into::into)
    }
}
