#[cfg(mobile)]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
mod error;
#[cfg(mobile)]
mod mobile;
mod models;
pub use error::Error;
#[cfg(mobile)]
pub use mobile::MobileOrientation;
pub use models::{ListenRequest, StopRequest};

#[cfg(mobile)]
pub trait MobileOrientationExt<R: Runtime> {
    fn mobile_orientation(&self) -> &MobileOrientation<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: Manager<R>> MobileOrientationExt<R> for T {
    fn mobile_orientation(&self) -> &MobileOrientation<R> {
        self.state::<MobileOrientation<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new("mobile-orientation")
        .setup(|app, api| {
            #[cfg(mobile)]
            app.manage(mobile::init(app, api)?);
            #[cfg(not(mobile))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
