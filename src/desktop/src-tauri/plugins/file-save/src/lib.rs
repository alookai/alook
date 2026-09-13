use serde::{Deserialize, Serialize};
use tauri::{plugin::{Builder,TauriPlugin}, Manager, Runtime};
#[cfg(mobile)] use tauri::plugin::PluginHandle;
#[cfg(target_os="ios")] tauri::ios_plugin_binding!(init_plugin_file_save);
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ExportRequest { pub attempt_id:String, pub path:String, pub name:String, pub mime:String, pub bytes:u64, pub sha256:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ExportResult { pub attempt_id:String, pub status:String, pub destination:String }
#[cfg(mobile)] pub struct FileSave<R:Runtime>(PluginHandle<R>);
#[cfg(desktop)] pub struct FileSave<R:Runtime>(std::marker::PhantomData<R>);
pub trait FileSaveExt<R:Runtime> { fn file_save(&self)->&FileSave<R>; }
impl<R:Runtime,T:Manager<R>> FileSaveExt<R> for T { fn file_save(&self)->&FileSave<R> { self.state::<FileSave<R>>().inner() } }
#[cfg(mobile)]
impl<R:Runtime> FileSave<R> {
    pub async fn export(&self,request:ExportRequest)->Result<ExportResult,tauri::plugin::mobile::PluginInvokeError> { self.0.run_mobile_plugin_async("exportFile",request).await }
    pub async fn cancel(&self,attempt_id:String)->Result<(),tauri::plugin::mobile::PluginInvokeError> { self.0.run_mobile_plugin_async("cancel",serde_json::json!({"attemptId":attempt_id})).await }
}
pub fn init<R:Runtime>()->TauriPlugin<R> {
    Builder::<R,()>::new("file-save").setup(|app,_api| {
        #[cfg(target_os="android")] let plugin=FileSave(_api.register_android_plugin("ai.alook.plugin.filesave","FileSavePlugin")?);
        #[cfg(target_os="ios")] let plugin=FileSave(_api.register_ios_plugin(init_plugin_file_save)?);
        #[cfg(desktop)] let plugin=FileSave::<R>(std::marker::PhantomData);
        app.manage(plugin); Ok(())
    }).build()
}
