#![cfg(target_os = "macos")]

use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};

fn close_stdout(command: &str, args: &[&str]) -> Option<i32> {
    let mut process = Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(process.stdout.take());
    process.wait().unwrap().signal()
}

#[test]
fn desktop_launch_keeps_the_default_broken_pipe_signal() {
    let direct = close_stdout("/usr/bin/yes", &[]);
    assert!(direct.is_some());
    let launched = close_stdout(
        env!("CARGO_BIN_EXE_alook-desktop"),
        &["--alook-agent-exec", "/usr/bin/yes"],
    );
    assert_eq!(launched, direct);
}
