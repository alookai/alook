use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;
mod models;

#[cfg(desktop)]
use desktop::MobileShareImage;
pub use error::Error;
#[cfg(mobile)]
use mobile::MobileShareImage;
pub use models::{CopyRequest, ImageResult, SaveRequest};

pub trait MobileShareImageExt<R: Runtime> {
    fn mobile_share_image(&self) -> &MobileShareImage<R>;
}

impl<R: Runtime, T: Manager<R>> MobileShareImageExt<R> for T {
    fn mobile_share_image(&self) -> &MobileShareImage<R> {
        self.state::<MobileShareImage<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new("mobile-share-image")
        .setup(|app, api| {
            #[cfg(mobile)]
            let plugin = mobile::init(app, api)?;
            #[cfg(desktop)]
            let plugin = desktop::init(app, api)?;
            app.manage(plugin);
            Ok(())
        })
        .build()
}
