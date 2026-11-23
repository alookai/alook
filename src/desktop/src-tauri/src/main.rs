#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    run_agent_launcher();
    alook_desktop_lib::run()
}

#[cfg(target_os = "macos")]
fn run_agent_launcher() {
    use std::{
        env,
        ffi::{CString, OsStr},
        os::unix::ffi::OsStrExt,
        process,
    };

    unsafe extern "C" {
        fn alook_macos_agent_exec(argv: *const *const std::ffi::c_char) -> i32;
    }

    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(OsStr::new("--alook-agent-exec")) {
        return;
    }
    let values: Vec<_> = arguments
        .map(|argument| CString::new(argument.as_bytes()).expect("OS argument contains NUL"))
        .collect();
    let pointers: Vec<_> = values
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    process::exit(unsafe { alook_macos_agent_exec(pointers.as_ptr()) });
}
