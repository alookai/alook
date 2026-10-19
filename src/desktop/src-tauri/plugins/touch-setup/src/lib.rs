pub mod error;
#[cfg(mobile)]
mod mobile;
pub mod models;
#[cfg(mobile)]
use tauri::plugin::PluginHandle;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_touch_setup);
#[cfg(mobile)]
pub struct TouchSetup<R: Runtime>(PluginHandle<R>);
#[cfg(desktop)]
pub struct TouchSetup<R: Runtime>(std::marker::PhantomData<R>);
pub trait TouchSetupExt<R: Runtime> {
    fn touch_setup(&self) -> &TouchSetup<R>;
}
impl<R: Runtime, T: Manager<R>> TouchSetupExt<R> for T {
    fn touch_setup(&self) -> &TouchSetup<R> {
        self.state::<TouchSetup<R>>().inner()
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new("touch-setup")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let plugin = TouchSetup(
                api.register_android_plugin("ai.alook.plugin.touchsetup", "TouchSetupPlugin")?,
            );
            #[cfg(target_os = "ios")]
            let plugin = TouchSetup(api.register_ios_plugin(init_plugin_touch_setup)?);
            #[cfg(desktop)]
            let plugin = {
                let _ = api;
                TouchSetup::<R>(std::marker::PhantomData)
            };
            app.manage(plugin);
            Ok(())
        })
        .build()
}
