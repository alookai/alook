#[cfg(desktop)]
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(desktop)]
static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_NATIVE_READY: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
pub fn should_hide_on_close(window_label: &str) -> bool {
    window_label == "main"
}

#[cfg(desktop)]
fn should_close_splash(native_ready: bool, closed: bool) -> bool {
    native_ready && !closed
}

#[cfg(desktop)]
pub(crate) struct DesktopLoadingLogo {
    pub styles: &'static str,
    pub markup: String,
    pub script: String,
}

#[cfg(desktop)]
fn normalize_logo_script(script: &str) -> String {
    script.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(desktop)]
pub(crate) fn desktop_loading_logo() -> DesktopLoadingLogo {
    let logo = include_str!("../../../../assets/alook.svg");
    let motion = include_str!("../../../web/src/components/brand/alook-loading/motion.js");
    let styles = r#"
#stage{position:relative;width:192px;height:192px;flex:none}
#canvas{position:absolute;width:1080px;height:1080px;transform:scale(.1777777778);transform-origin:top left;visibility:hidden}
#clip{position:absolute;left:210px;top:210px;width:660px;height:660px}
#orbit,.face,.art{position:absolute;inset:0;width:660px;height:660px}
.face,.art{transform-origin:center}
.art svg{display:block;width:660px;height:660px;overflow:visible}
#initial{position:absolute;left:50%;top:50%;width:117.3333333333px;height:117.3333333333px;transform:translate(-50%,-50%)}
#initial svg{display:block;width:100%;height:100%}
"#;
    let markup = format!(
        r#"<div id="stage" role="status" aria-label="Loading"><div id="canvas" aria-hidden="true"><div id="clip"><div id="orbit"></div></div></div><div id="initial" aria-hidden="true">{logo}</div></div>"#,
    );
    let mut script = String::with_capacity(motion.len() + 4_096);
    script.push_str(motion);
    script.push_str(
        r##"
const bots=[
  {face:"red",x:-100,y:-45,scale:.8,tilt:8},
  {face:"purple",x:-20,y:-55,scale:.78,tilt:-9},
  {face:"teal",x:-200,y:20,scale:.76,tilt:-7},
  {face:"blue",x:-85,y:0,scale:.77,tilt:7},
  {face:"orange",x:55,y:130,scale:.76,tilt:-5}
];
const source=document.querySelector("#initial");
const clip=document.querySelector("#clip");
const orbitElement=document.querySelector("#orbit");
const namespace="http://www.w3.org/2000/svg";
const faces=bots.map((bot,index)=>{
  const wrapper=document.createElement("div");
  wrapper.className="face";
  wrapper.style.zIndex=String(index+1);
  const art=document.createElement("div");
  art.className="art";
  const svg=document.createElementNS(namespace,"svg");
  svg.setAttribute("viewBox","0 0 1024 1024");
  svg.setAttribute("aria-hidden","true");
  const group=source.querySelector(`[data-face="${bot.face}"]`).cloneNode(true);
  const pupils=bot.face==="orange"?[group.children[2],group.children[4]]:[];
  svg.appendChild(group);
  art.appendChild(svg);
  wrapper.appendChild(art);
  (index<4?orbitElement:clip).appendChild(wrapper);
  return {wrapper,art,expressions:[...group.querySelectorAll('[data-part="expression"]')],pupils};
});
function apply(frame){
  const {joined,orbit,look}=motionAt(frame);
  clip.style.clipPath=`inset(${-300*(1-joined)}px round ${152.109375*joined}px)`;
  orbitElement.style.rotate=`${orbit}deg`;
  for(let index=0;index<faces.length;index+=1){
    const bot=bots[index];
    const face=faces[index];
    face.wrapper.style.translate=`${bot.x*.96*(1-joined)}px ${bot.y*.96*(1-joined)}px`;
    face.wrapper.style.scale=String(bot.scale+(1-bot.scale)*joined);
    face.art.style.rotate=`${look*bot.tilt}deg`;
    const expressionOpacity=index===4?1:1-smooth((joined-.45)/.55);
    for(const expression of face.expressions)expression.style.opacity=String(expressionOpacity);
    for(const pupil of face.pupils)pupil.setAttribute("transform",`translate(${look*23.2} 0)`);
  }
}
const media=window.matchMedia("(prefers-reduced-motion: reduce)");
let elapsed=0;
let last;
let request=0;
function tick(now){
  if(last!==undefined)elapsed+=now-last;
  last=now;
  apply(Math.floor(elapsed*60/1000)%DURATION);
  request=requestAnimationFrame(tick);
}
function sync(){
  cancelAnimationFrame(request);
  last=undefined;
  if(media.matches)apply(REDUCED_MOTION_FRAME);
  else{
    apply(0);
    if(!document.hidden)request=requestAnimationFrame(tick);
  }
}
media.addEventListener("change",sync);
document.addEventListener("visibilitychange",sync);
sync();
document.querySelector("#canvas").style.visibility="visible";
source.remove();
"##,
    );
    DesktopLoadingLogo {
        styles,
        markup,
        script: normalize_logo_script(&script),
    }
}

#[cfg(desktop)]
pub fn splash_html() -> String {
    let logo = desktop_loading_logo();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:100%;height:100%;overflow:hidden;background:transparent;display:flex;align-items:center;justify-content:center;-webkit-user-select:none;user-select:none}}
{styles}</style></head><body>{markup}<script type="module">{script}</script></body></html>"#,
        styles = logo.styles,
        markup = logo.markup,
        script = logo.script,
    )
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) const QA_NOTIFICATION_STORE_ID: [u8; 16] = [
    158, 83, 199, 44, 135, 159, 85, 131, 171, 124, 5, 37, 18, 176, 5, 21,
];

#[cfg(all(target_os = "macos", debug_assertions))]
fn qa_main_window_config(
    config: &tauri::utils::config::Config,
) -> Result<Option<(tauri::utils::config::WindowConfig, [u8; 16])>, &'static str> {
    if config.identifier != "ai.alook.desktop.qa.madox.notification208" {
        return Ok(None);
    }
    let window = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or("qa_main_unavailable")?;
    if window.create {
        return Err("qa_auto_main_enabled");
    }
    let store = window
        .data_store_identifier
        .filter(|store| *store == QA_NOTIFICATION_STORE_ID)
        .ok_or("qa_store_unavailable")?;
    Ok(Some((window, store)))
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub fn create_qa_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let Some((config, store)) = qa_main_window_config(app.config())? else {
        return Ok(());
    };
    if app.get_webview_window("main").is_some() {
        return Err("qa_auto_main_present".into());
    }
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .data_store_identifier(store)
        .build()?;
    crate::system_notifications::diagnose_qa_store(&window);
    Ok(())
}

#[cfg(desktop)]
pub fn create_splash_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let builder = WebviewWindowBuilder::new(
        app,
        "splash",
        WebviewUrl::CustomProtocol("splash://index".parse()?),
    );
    #[cfg(all(target_os = "macos", debug_assertions))]
    let builder = if app.config().identifier == "ai.alook.desktop.qa.madox.notification208" {
        let store = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .and_then(|window| window.data_store_identifier)
            .ok_or("qa_store_unavailable")?;
        builder.data_store_identifier(store)
    } else {
        builder
    };
    let _window = builder
        .title("Alook")
        .inner_size(240.0, 240.0)
        .center()
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()?;
    #[cfg(all(target_os = "macos", debug_assertions))]
    crate::system_notifications::diagnose_qa_store(&_window);

    Ok(())
}

#[cfg(desktop)]
pub fn finish_native_startup(
    handle: &AppHandle,
    diagnostic_main: Option<&mut Option<tauri::WebviewWindow>>,
) -> bool {
    SPLASH_NATIVE_READY.store(true, Ordering::SeqCst);
    try_close_splashscreen(handle, diagnostic_main)
}

#[cfg(target_os = "macos")]
pub fn show_startup_initialization_error<R: tauri::Runtime>(handle: &AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let mut dialog = handle
        .dialog()
        .message("Alook could not start. Close and reopen the app.")
        .title("Alook")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Close Alook".into()));
    if let Some(splash) = handle.get_webview_window("splash") {
        dialog = dialog.parent(&splash);
    }
    let exit_handle = handle.clone();
    dialog.show(move |_| exit_handle.exit(1));
}

#[cfg(desktop)]
fn try_close_splashscreen(
    handle: &AppHandle,
    diagnostic_main: Option<&mut Option<tauri::WebviewWindow>>,
) -> bool {
    #[cfg(all(target_os = "macos", debug_assertions))]
    let mut diagnostic_main = diagnostic_main
        .filter(|_| crate::system_notifications::notification_diagnostics_enabled(handle));
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    let _ = diagnostic_main;
    if SPLASH_CLOSED.load(Ordering::SeqCst) {
        #[cfg(all(target_os = "macos", debug_assertions))]
        if diagnostic_main.is_some() {
            crate::system_notifications::diagnose_qa_startup(
                handle,
                "already_closed_flag",
                "main",
                serde_json::json!({ "completed": true }),
            );
        }
        return true;
    }
    if !should_close_splash(SPLASH_NATIVE_READY.load(Ordering::SeqCst), false) {
        #[cfg(all(target_os = "macos", debug_assertions))]
        if diagnostic_main.is_some() {
            crate::system_notifications::diagnose_qa_startup(
                handle,
                "native_not_ready",
                "main",
                serde_json::json!({ "completed": false }),
            );
        }
        return false;
    }
    let Some(main) = handle.get_webview_window("main") else {
        #[cfg(all(target_os = "macos", debug_assertions))]
        if diagnostic_main.is_some() {
            crate::system_notifications::diagnose_qa_startup(
                handle,
                "main_absent",
                "main",
                serde_json::json!({ "completed": false }),
            );
        }
        return false;
    };
    let shown = main.show();
    #[cfg(all(target_os = "macos", debug_assertions))]
    if diagnostic_main.is_some() {
        crate::system_notifications::diagnose_qa_startup(
            handle,
            "show_return",
            main.label(),
            serde_json::json!({ "status": if shown.is_ok() { "ok" } else { "error" }, "error": shown.as_ref().err().map(ToString::to_string) }),
        );
    }
    if let Err(error) = shown {
        eprintln!("startup main window unavailable: {error}");
        return false;
    }
    #[cfg(all(target_os = "macos", debug_assertions))]
    if let Some(captured) = diagnostic_main.as_deref_mut() {
        *captured = Some(main.clone());
    }
    let focused = main.set_focus();
    #[cfg(all(target_os = "macos", debug_assertions))]
    if diagnostic_main.is_some() {
        crate::system_notifications::diagnose_qa_startup(
            handle,
            "focus_return",
            main.label(),
            serde_json::json!({ "status": if focused.is_ok() { "ok" } else { "error" }, "error": focused.as_ref().err().map(ToString::to_string) }),
        );
    }
    let _ = focused;
    if let Some(splash) = handle.get_webview_window("splash") {
        let closed = splash.close();
        #[cfg(all(target_os = "macos", debug_assertions))]
        if diagnostic_main.is_some() {
            crate::system_notifications::diagnose_qa_startup(
                handle,
                "close_request_return",
                splash.label(),
                serde_json::json!({ "status": if closed.is_ok() { "request_queued" } else { "error" }, "error": closed.as_ref().err().map(ToString::to_string) }),
            );
        }
        if let Err(error) = closed {
            eprintln!("startup splash close unavailable: {error}");
            return false;
        }
    } else {
        #[cfg(all(target_os = "macos", debug_assertions))]
        if diagnostic_main.is_some() {
            crate::system_notifications::diagnose_qa_startup(
                handle,
                "close_request_return",
                "splash",
                serde_json::json!({ "status": "absent" }),
            );
        }
    }
    SPLASH_CLOSED.store(true, Ordering::SeqCst);
    true
}

#[cfg(desktop)]
#[tauri::command]
pub fn close_splashscreen(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        try_close_splashscreen(&handle, None);
    });
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_window_theme(
    window: tauri::WebviewWindow,
    dark: bool,
    background: Option<tauri::window::Color>,
) {
    let color = background.filter(|color| color.3 == 255).unwrap_or_else(|| {
        if dark {
            tauri::window::Color(0, 0, 0, 255)
        } else {
            tauri::window::Color(250, 246, 238, 255)
        }
    });
    let _ = window.set_background_color(Some(color));
}

#[cfg(desktop)]
pub fn show_main_window(app: &AppHandle) {
    if !SPLASH_CLOSED.load(Ordering::SeqCst) {
        if let Some(splash) = app.get_webview_window("splash") {
            let _ = splash.show();
            let _ = splash.set_focus();
        }
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayMenuAction {
    Show,
    Quit,
}

#[cfg(desktop)]
fn tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        "show" => Some(TrayMenuAction::Show),
        "quit" => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-macos-template.png");
#[cfg(target_os = "macos")]
const TRAY_ICON_IS_TEMPLATE: bool = true;

#[cfg(any(target_os = "windows", target_os = "linux"))]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-windows-linux-color.png");
#[cfg(any(target_os = "windows", target_os = "linux"))]
const TRAY_ICON_IS_TEMPLATE: bool = false;

#[cfg(desktop)]
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        image::Image,
        menu::{MenuBuilder, MenuItemBuilder},
        tray::TrayIconBuilder,
    };

    let show = MenuItemBuilder::with_id("show", "Open Alook").build(app)?;
    let version =
        MenuItemBuilder::with_id("version", format!("Version {}", app.package_info().version))
            .enabled(false)
            .build(app)?;
    let update_item = MenuItemBuilder::with_id(
        crate::updater::CHECK_FOR_UPDATES_MENU_ID,
        "Check for Updates…",
    )
    .build(app)?;
    crate::updater::register_tray_update_item(update_item.clone());
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&version)
        .item(&update_item)
        .separator()
        .item(&quit)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .icon(Image::from_bytes(TRAY_ICON_BYTES).expect("tray icon"))
        .icon_as_template(TRAY_ICON_IS_TEMPLATE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Alook")
        .on_menu_event(
            move |app, event| match tray_menu_action(event.id().as_ref()) {
                Some(TrayMenuAction::Show) => show_main_window(app),
                Some(TrayMenuAction::Quit) => {
                    app.exit(0);
                }
                None => {}
            },
        )
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(target_os = "macos", debug_assertions))]
    fn qa_window_config_fixture() -> tauri::utils::config::Config {
        let mut config = tauri::utils::config::Config::default();
        config.identifier = "ai.alook.desktop.qa.madox.notification208".into();
        config.app.windows = vec![serde_json::from_value(serde_json::json!({
            "label": "main", "title": "QA original", "url": "alook-recovery://localhost/bootstrap",
            "width": 1173, "height": 719, "visible": false, "create": false,
            "dataStoreIdentifier": QA_NOTIFICATION_STORE_ID,
        }))
        .unwrap()];
        config
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn qa_main_preparation_keeps_the_complete_original_window_configuration() {
        let config = qa_window_config_fixture();
        let original = serde_json::to_value(&config.app.windows[0]).unwrap();
        let (window, store) = qa_main_window_config(&config).unwrap().unwrap();
        assert_eq!(serde_json::to_value(window).unwrap(), original);
        assert_eq!(store, QA_NOTIFICATION_STORE_ID);
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn qa_main_preparation_does_not_apply_to_another_bundle() {
        let mut config = qa_window_config_fixture();
        config.identifier = "ai.alook.desktop".into();
        config.app.windows[0].create = true;
        config.app.windows[0].data_store_identifier = None;
        let original = serde_json::to_value(&config).unwrap();
        assert!(qa_main_window_config(&config).unwrap().is_none());
        assert_eq!(serde_json::to_value(config).unwrap(), original);
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn qa_main_preparation_rejects_missing_store_and_automatic_creation() {
        let mut config = qa_window_config_fixture();
        config.app.windows[0].create = true;
        assert_eq!(
            qa_main_window_config(&config).err(),
            Some("qa_auto_main_enabled")
        );
        config.app.windows[0].create = false;
        config.app.windows[0].data_store_identifier = None;
        assert_eq!(
            qa_main_window_config(&config).err(),
            Some("qa_store_unavailable")
        );
        config.app.windows[0].data_store_identifier = Some([0; 16]);
        assert_eq!(
            qa_main_window_config(&config).err(),
            Some("qa_store_unavailable")
        );
        config.app.windows.clear();
        assert_eq!(
            qa_main_window_config(&config).err(),
            Some("qa_main_unavailable")
        );
    }

    #[test]
    fn tray_routes_only_tray_owned_actions() {
        assert_eq!(tray_menu_action("show"), Some(TrayMenuAction::Show));
        assert_eq!(tray_menu_action("quit"), Some(TrayMenuAction::Quit));
        assert_eq!(
            tray_menu_action(crate::updater::CHECK_FOR_UPDATES_MENU_ID),
            None
        );
        assert_eq!(tray_menu_action("unknown"), None);
    }

    #[test]
    fn tray_icon_template_mode_matches_the_current_platform() {
        let image = tauri::image::Image::from_bytes(TRAY_ICON_BYTES).expect("compiled tray image");
        assert_eq!((image.width(), image.height()), (36, 36));
        assert_eq!(image.rgba().len(), 36 * 36 * 4);
        let pixels: Vec<_> = image.rgba().chunks_exact(4).collect();
        assert!(pixels.iter().any(|pixel| pixel[3] > 0));
        assert!(pixels.iter().any(|pixel| pixel[3] == 0));
        assert_eq!(TRAY_ICON_IS_TEMPLATE, cfg!(target_os = "macos"));
        if cfg!(target_os = "macos") {
            assert!(pixels
                .iter()
                .filter(|pixel| pixel[3] > 0)
                .all(|pixel| pixel[..3] == [0, 0, 0]));
        } else {
            let colors: std::collections::HashSet<_> = pixels
                .iter()
                .filter(|pixel| pixel[3] > 0)
                .map(|pixel| [pixel[0], pixel[1], pixel[2]])
                .collect();
            assert!(colors.len() > 5);
        }
    }

    #[test]
    fn desktop_registers_no_daemon_lifecycle_commands() {
        let app_source = include_str!("lib.rs");
        for rejected in [
            "commands::daemon_start",
            "commands::daemon_stop",
            "commands::daemon_status",
            "commands::register_cli",
            "commands::cli_update",
            "commands::cli_check",
            "commands::check_for_updates",
            "commands::install_update",
            "auto_start_daemon",
            "prevent_exit",
        ] {
            assert!(
                !app_source.contains(rejected),
                "found rejected lifecycle hook: {rejected}"
            );
        }
    }

    #[test]
    fn desktop_restores_the_main_window_on_macos_reopen() {
        let app_source = include_str!("lib.rs");
        assert!(app_source.contains("tauri::RunEvent::Reopen"));
        assert!(app_source.contains("commands::show_main_window(app)"));
    }

    #[test]
    fn desktop_restores_the_main_window_for_a_second_instance() {
        let app_source = include_str!("lib.rs");
        let single_instance = app_source
            .find("tauri_plugin_single_instance::init")
            .unwrap();
        let updater = app_source.find("tauri_plugin_updater::Builder").unwrap();
        assert!(single_instance < updater);
        assert!(app_source[single_instance..updater].contains("show_main_window(app)"));
    }

    #[test]
    fn close_to_hide_applies_only_to_the_main_window() {
        assert!(should_hide_on_close("main"));
        assert!(!should_hide_on_close("splash"));
        assert!(!should_hide_on_close("settings"));

        let app_source = include_str!("lib.rs");
        assert!(app_source.contains("should_hide_on_close(window.label())"));
    }

    #[test]
    fn splash_closes_only_after_native_readiness_and_only_once() {
        assert!(!should_close_splash(false, false));
        assert!(should_close_splash(true, false));
        assert!(!should_close_splash(false, true));
        assert!(!should_close_splash(true, true));
    }

    #[test]
    fn desktop_splash_matches_the_main_unknown_neutral_motion() {
        let html = splash_html();
        let canonical = include_str!("../../../../assets/alook.svg");
        let web_motion = include_str!("../../../web/src/components/brand/alook-loading/motion.js");
        let web_frame =
            include_str!("../../../web/src/components/brand/alook-loading/LoadingFrame.tsx");

        assert!(html.contains(canonical));
        assert!(html.contains("#stage{position:relative;width:192px;height:192px"));
        assert!(html.contains("<script type=\"module\">"));
        assert_eq!(
            html.match_indices(&normalize_logo_script(web_motion))
                .count(),
            1
        );
        assert_eq!(html.matches("export const DURATION = 540").count(), 1);
        assert_eq!(html.matches("export const motionAt").count(), 1);
        assert!(!html.contains("const DURATION=540"));
        assert!(!html.contains("function motionAt("));
        assert!(!html.contains("function smooth("));
        assert!(html.contains("expressionOpacity=index===4?1:1-smooth((joined-.45)/.55)"));
        assert!(html.contains("apply(REDUCED_MOTION_FRAME)"));
        assert!(html.contains("prefers-reduced-motion: reduce"));
        assert!(!html.contains("data:image/png"));
        assert!(web_motion.contains("export const REDUCED_MOTION_FRAME = 0"));
        assert!(web_motion.contains("const times = [204, 240, 270, 306, 342, 366]"));
        assert!(web_motion.contains("const values = [0, -1, -1, 1, 1, 0]"));
        assert!(web_frame.contains("width: 660"));
        assert!(web_frame.contains("height: 660"));
        assert!(web_frame.contains("rotate: `${orbit}deg`"));
    }

    #[test]
    fn desktop_splash_applies_complete_frame_before_the_first_animation_request() {
        let html = splash_html();
        let sync_start = html.find("function sync(){").unwrap();
        let sync_end = html[sync_start..]
            .find("media.addEventListener")
            .map(|offset| sync_start + offset)
            .unwrap();
        let sync = &html[sync_start..sync_end];
        let complete_frame = sync.find("apply(0);").unwrap();
        let first_request = sync.find("request=requestAnimationFrame(tick);").unwrap();

        assert!(complete_frame < first_request);
        assert!(html.contains(
            "clip.style.clipPath=`inset(${-300*(1-joined)}px round ${152.109375*joined}px)`"
        ));
        assert!(html.contains(
            "face.wrapper.style.translate=`${bot.x*.96*(1-joined)}px ${bot.y*.96*(1-joined)}px`"
        ));
        assert!(html.contains("face.wrapper.style.scale=String(bot.scale+(1-bot.scale)*joined)"));
        assert!(html.contains("face.art.style.rotate=`${look*bot.tilt}deg`"));
        assert!(html.contains("const expressionOpacity=index===4?1:1-smooth((joined-.45)/.55)"));
        assert!(html.contains("expression.style.opacity=String(expressionOpacity)"));
    }

    #[test]
    fn desktop_logo_is_visible_before_script_and_survives_failed_enhancement() {
        let html = splash_html();
        let canonical = include_str!("../../../../assets/alook.svg");
        let body = html.split("<body>").nth(1).unwrap();
        let initial = body.split("<script").next().unwrap();
        assert_eq!(initial.matches(canonical).count(), 1);
        assert!(initial.contains("<div id=\"initial\" aria-hidden=\"true\"><svg"));
        assert!(!initial.contains("<template"));
        assert!(html.contains("#initial{position:absolute;left:50%;top:50%;width:117.3333333333px;height:117.3333333333px"));
        assert!(html.contains("transform-origin:top left;visibility:hidden}"));
        let script = desktop_loading_logo().script;
        let enhance = script.rfind("sync();").unwrap();
        let reveal = script
            .find("document.querySelector(\"#canvas\").style.visibility=\"visible\"")
            .unwrap();
        let remove = script.find("source.remove();").unwrap();
        assert!(enhance < reveal && reveal < remove);
        assert_eq!(script.matches("source.remove();").count(), 1);
        assert!(!script.contains("location."));
    }

    #[test]
    fn desktop_logo_script_normalizes_all_html_line_endings_before_embedding() {
        let logo = desktop_loading_logo();
        let windows = logo.script.replace('\n', "\r\n");
        let old_mac = logo.script.replace('\n', "\r");
        assert!(windows.contains("\r\n"));
        assert!(old_mac.contains('\r'));
        assert!(!logo.script.contains('\r'));
        assert_eq!(normalize_logo_script(&windows), logo.script);
        assert_eq!(normalize_logo_script(&old_mac), logo.script);
        let html = splash_html();
        let embedded = html
            .split("<script type=\"module\">")
            .nth(1)
            .unwrap()
            .split("</script>")
            .next()
            .unwrap();
        assert_eq!(embedded, logo.script);
    }

    #[test]
    fn desktop_remote_capability_has_no_plugin_permissions_or_localhost() {
        let capability = include_str!("../capabilities/desktop.json");
        assert!(capability.contains("https://alook.ai"));
        assert!(!capability.contains("localhost"));
        for rejected in [
            "shell:",
            "autostart:",
            "global-shortcut:",
            "updater:",
            "dialog:",
            "notification:",
            "deep-link:",
        ] {
            assert!(!capability.contains(rejected));
        }

        let app_source = include_str!("lib.rs");
        let cargo_manifest = include_str!("../Cargo.toml");
        for removed in ["autostart", "global_shortcut"] {
            assert!(!app_source.contains(removed));
            assert!(!cargo_manifest.contains(&removed.replace('_', "-")));
        }
    }

    #[test]
    fn mobile_placeholder_plugins_are_not_linked_or_registered() {
        let app_source = include_str!("lib.rs");
        let cargo_manifest = include_str!("../Cargo.toml");
        for removed in ["tauri_plugin_biometric", "tauri_plugin_push"] {
            assert!(!app_source.contains(removed));
            assert!(!cargo_manifest.contains(&removed.replace('_', "-")));
        }
        let common_dependencies = cargo_manifest
            .split("[target.\"cfg(not(any(target_os = \\\"android\\\", target_os = \\\"ios\\\")))\".dependencies]")
            .next()
            .unwrap();
        assert!(!common_dependencies.contains("tauri-plugin-notification"));
        assert!(app_source.contains(".plugin(tauri_plugin_notification::init())"));
    }
}
