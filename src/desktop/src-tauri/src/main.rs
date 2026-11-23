#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    run_agent_launcher();
    alook_desktop_lib::run()
}

#[cfg(target_os = "macos")]
fn run_agent_launcher() {
    use std::{env, ffi::CString, os::unix::ffi::OsStrExt, process};

    unsafe extern "C" {
        fn alook_macos_agent_main(argc: i32, argv: *const *const std::ffi::c_char) -> i32;
    }

    let arguments: Vec<_> = env::args_os().collect();
    let Some(mode) = arguments.get(1).and_then(|value| value.to_str()) else {
        return;
    };
    if !matches!(mode, "--alook-agent-supervise" | "--alook-agent-exec") {
        return;
    }
    let Ok(executable) = env::current_exe().and_then(|path| path.canonicalize()) else {
        process::exit(125);
    };
    let values: Vec<_> = std::iter::once(executable.into_os_string())
        .chain(arguments.into_iter().skip(1))
        .map(|argument| CString::new(argument.as_bytes()).expect("OS argument contains NUL"))
        .collect();
    let pointers: Vec<_> = values.iter().map(|value| value.as_ptr()).collect();
    process::exit(unsafe { alook_macos_agent_main(pointers.len() as i32, pointers.as_ptr()) });
}
