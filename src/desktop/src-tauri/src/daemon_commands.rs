#[cfg(desktop)]
use serde::Serialize;
#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[cfg(desktop)]
use command_group::CommandGroup;

#[cfg(desktop)]
const PATH_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(desktop)]
const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(desktop)]
const DAEMON_PAIR_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize)]
#[cfg(desktop)]
pub struct CommandResult {
    pub success: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg(desktop)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRuntimeCapability {
    pub available: bool,
    pub reason: Option<String>,
    pub node_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg(desktop)]
struct DaemonConfig {
    command: &'static str,
    base_args: &'static [&'static str],
    cwd: Option<PathBuf>,
}

#[cfg(desktop)]
fn daemon_config() -> DaemonConfig {
    daemon_config_for(cfg!(debug_assertions))
}

#[cfg(desktop)]
fn daemon_config_for(is_debug: bool) -> DaemonConfig {
    if is_debug {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let monorepo_root = manifest_dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        DaemonConfig {
            command: "pnpm",
            base_args: &[],
            cwd: monorepo_root,
        }
    } else {
        DaemonConfig {
            command: "npm",
            base_args: &[
                "exec",
                "--yes",
                "--package=@alook/daemon@latest",
                "--",
                "alook-daemon",
            ],
            cwd: None,
        }
    }
}

#[cfg(desktop)]
fn executable_for_platform(command: &str, is_windows: bool) -> String {
    if is_windows && matches!(command, "npm" | "pnpm") {
        format!("{command}.cmd")
    } else {
        command.to_string()
    }
}

#[cfg(desktop)]
fn executable(command: &str) -> String {
    executable_for_platform(command, cfg!(windows))
}

#[cfg(desktop)]
fn daemon_endpoints_for(is_debug: bool) -> (&'static str, &'static str) {
    if is_debug {
        ("http://localhost:3000", "ws://localhost:8789")
    } else {
        ("https://alook.ai", "wss://alook.ai/api/ws/community-daemon")
    }
}

#[cfg(desktop)]
#[derive(Debug)]
struct DaemonOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(desktop)]
fn read_process_pipe<R: Read + Send + 'static>(pipe: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.take(1024 * 1024 + 1).read_to_end(&mut bytes);
        bytes
    })
}

#[cfg(desktop)]
fn run_process_with_timeout(
    mut command: Command,
    timeout: Duration,
    timeout_message: String,
) -> Result<DaemonOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.group_spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .inner()
        .stdout
        .take()
        .map(read_process_pipe)
        .ok_or("failed to capture process stdout")?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .map(read_process_pipe)
        .ok_or("failed to capture process stderr")?;
    let deadline = Instant::now() + timeout;

    let mut status = None;
    loop {
        if status.is_none() {
            status = child.try_wait().map_err(|error| error.to_string())?;
        }
        if status.is_some() && stdout.is_finished() && stderr.is_finished() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(timeout_message);
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let stdout = stdout.join().map_err(|_| "stdout reader failed")?;
    let stderr = stderr.join().map_err(|_| "stderr reader failed")?;
    Ok(DaemonOutput {
        success: status.is_some_and(|status| status.success()),
        stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
    })
}

#[cfg(desktop)]
async fn run_process(
    command: Command,
    timeout: Duration,
    timeout_message: String,
) -> Result<DaemonOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_process_with_timeout(command, timeout, timeout_message)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(desktop)]
fn parse_shell_path(stdout: &str) -> Option<String> {
    let value = stdout.trim();
    if value.is_empty() || value.lines().count() != 1 {
        return None;
    }
    let paths: Vec<PathBuf> = std::env::split_paths(value).collect();
    if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
        return None;
    }
    Some(value.to_string())
}

#[cfg(desktop)]
const ENV_MARKER: &str = "__ALOOK_ENV_V1__";

#[cfg(desktop)]
fn parse_shell_environment(
    stdout: &str,
    is_windows: bool,
) -> Result<Vec<(String, String)>, String> {
    let invalid =
        || "Could not read the shell environment. The daemon was not changed.".to_string();
    if stdout.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let marker = if is_windows {
        ENV_MARKER.to_string()
    } else {
        format!("{ENV_MARKER}\0")
    };
    let (_, data) = stdout.rsplit_once(&marker).ok_or_else(invalid)?;
    let entries: Vec<(String, String)> = if is_windows {
        let values: std::collections::BTreeMap<String, String> =
            serde_json::from_str(data).map_err(|_| invalid())?;
        values
            .into_iter()
            .map(|(key, value)| (key.to_uppercase(), value))
            .collect()
    } else {
        data.split('\0')
            .filter(|item| !item.is_empty())
            .map(|item| {
                item.split_once('=')
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .ok_or_else(invalid)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    if entries
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err(invalid());
    }
    let path = entries
        .iter()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.as_str());
    let home_key = if is_windows { "USERPROFILE" } else { "HOME" };
    if !entries
        .iter()
        .any(|(key, value)| key == home_key && !value.is_empty())
        || path.and_then(parse_shell_path).is_none()
    {
        return Err(invalid());
    }
    Ok(entries)
}

#[cfg(desktop)]
fn shell_environment_command_for(environment: Vec<(String, String)>, is_windows: bool) -> Command {
    let allowed = [
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TERM",
        "ZDOTDIR",
        "XDG_CONFIG_HOME",
        "XDG_RUNTIME_DIR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "SSH_AUTH_SOCK",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "USERPROFILE",
        "USERNAME",
        "USERDOMAIN",
        "ALLUSERSPROFILE",
        "PUBLIC",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
    ];
    let baseline: Vec<_> = environment
        .iter()
        .cloned()
        .filter(|(key, _)| allowed.contains(&key.to_uppercase().as_str()))
        .collect();
    let mut command;
    if is_windows {
        let root = environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("SystemRoot"))
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| r"C:\Windows".to_string());
        command = Command::new(
            PathBuf::from(&root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command
            .env_clear()
            .envs(baseline)
            .env("Path", PathBuf::from(root).join("System32"));
        let lines: Vec<String> = serde_json::from_str(include_str!(
            "../../../daemon/src/cli/windows-shell-environment.json"
        ))
        .expect("invalid bundled Windows shell script");
        let script = lines.join("; ");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script.as_str(),
        ]);
    } else {
        let shell = environment
            .iter()
            .find(|(key, _)| key == "SHELL")
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| "/bin/sh".to_string());
        command = Command::new(shell);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let name = PathBuf::from(command.get_program())
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            command.arg0(format!("-{name}"));
        }
        command
            .env_clear()
            .envs(baseline)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        command.args([
            "-ic",
            "printf '__ALOOK_ENV_V1__\\000'; exec /usr/bin/env -0",
        ]);
    }
    command
}

#[cfg(desktop)]
fn parse_configured_shell(stdout: &str, is_macos: bool) -> Option<String> {
    let output = stdout.trim();
    let shell = if is_macos {
        output.strip_prefix("UserShell:")?.trim()
    } else {
        output.split(':').nth(6)?.trim()
    };
    (shell.lines().count() == 1 && PathBuf::from(shell).is_absolute()).then(|| shell.to_string())
}

#[cfg(desktop)]
async fn configured_login_shell(environment: &[(String, String)]) -> Result<String, String> {
    let failure = "Could not find this account's login shell.".to_string();
    let user = environment
        .iter()
        .find(|(key, _)| key == "USER" || key == "LOGNAME")
        .map(|(_, value)| value)
        .ok_or_else(|| failure.clone())?;
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("/usr/bin/dscl");
        command.args([".", "-read", &format!("/Users/{user}"), "UserShell"]);
        command
    } else {
        let mut command = Command::new("/usr/bin/getent");
        command.args(["passwd", user]);
        command
    };
    command.env_clear().envs(environment.iter().cloned());
    let output = run_process(command, PATH_DISCOVERY_TIMEOUT, failure.clone())
        .await
        .map_err(|_| failure.clone())?;
    if !output.success {
        return Err(failure);
    }
    parse_configured_shell(&output.stdout, cfg!(target_os = "macos")).ok_or(failure)
}

#[cfg(desktop)]
async fn resolve_environment() -> Result<Vec<(String, String)>, String> {
    let failure = "Could not read the shell environment. The daemon was not changed.".to_string();
    let mut environment: Vec<_> = std::env::vars().collect();
    if !cfg!(windows)
        && !environment
            .iter()
            .any(|(key, value)| key == "SHELL" && !value.is_empty())
    {
        let shell = configured_login_shell(&environment)
            .await
            .map_err(|_| failure.clone())?;
        environment.retain(|(key, _)| key != "SHELL");
        environment.push(("SHELL".to_string(), shell));
    }
    let output = run_process(
        shell_environment_command_for(environment, cfg!(windows)),
        PATH_DISCOVERY_TIMEOUT,
        failure.clone(),
    )
    .await
    .map_err(|_| failure.clone())?;
    if !output.success {
        return Err(failure);
    }
    parse_shell_environment(&output.stdout, cfg!(windows))
}

#[cfg(desktop)]
async fn run_daemon(extra_args: &[String]) -> Result<DaemonOutput, String> {
    let cfg = daemon_config();
    let args = daemon_argv(&cfg, extra_args);

    let mut command = Command::new(executable(cfg.command));
    command.env_clear().envs(resolve_environment().await?);
    if let Some(cwd) = &cfg.cwd {
        command.current_dir(cwd);
    }
    command.args(&args);
    run_process(
        command,
        DAEMON_PAIR_TIMEOUT,
        "The daemon didn't start within 60 seconds. Check your network and try again.".to_string(),
    )
    .await
}

#[cfg(desktop)]
fn daemon_argv(cfg: &DaemonConfig, extra_args: &[String]) -> Vec<String> {
    cfg.base_args
        .iter()
        .map(|arg| (*arg).to_string())
        .chain(extra_args.iter().cloned())
        .collect()
}

#[cfg(desktop)]
fn valid_machine_key(machine_key: &str) -> bool {
    let value = machine_key
        .strip_prefix("cmt_")
        .or_else(|| machine_key.strip_prefix("cmk_"));
    let Some(value) = value else {
        return false;
    };
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(desktop)]
fn valid_machine_id(machine_id: &str) -> bool {
    let Some(value) = machine_id.strip_prefix("cm_") else {
        return false;
    };
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(desktop)]
fn daemon_pair_args(
    machine_key: &str,
    machine_id: Option<&str>,
    is_debug: bool,
) -> Result<Vec<String>, String> {
    if !valid_machine_key(machine_key) {
        return Err("invalid Community machine key".to_string());
    }
    if let Some(machine_id) = machine_id {
        if !machine_key.starts_with("cmt_") || !valid_machine_id(machine_id) {
            return Err("invalid Community reconnect identity".to_string());
        }
    }
    let (server_url, ws_url) = daemon_endpoints_for(is_debug);
    let mut args = vec![
        "daemon".to_string(),
        if machine_id.is_some() {
            "reconnect".to_string()
        } else {
            "start".to_string()
        },
    ];
    if let Some(machine_id) = machine_id {
        args.extend(["--id".to_string(), machine_id.to_string()]);
    }
    args.extend([
        "--machine-key".to_string(),
        machine_key.to_string(),
        "--server-url".to_string(),
        server_url.to_string(),
        "--ws-url".to_string(),
        ws_url.to_string(),
    ]);
    Ok(args)
}

#[cfg(desktop)]
fn evaluate_runtime_capability(
    node: Result<String, String>,
    npm: Result<String, String>,
) -> DaemonRuntimeCapability {
    let node_output = match node {
        Ok(output) => output,
        Err(reason) => {
            return DaemonRuntimeCapability {
                available: false,
                reason: Some(format!("Node.js is required: {reason}.")),
                node_version: None,
            };
        }
    };
    if let Err(reason) = npm {
        return DaemonRuntimeCapability {
            available: false,
            reason: Some(format!(
                "Node.js is available, but {reason}. Install npm with Node.js and try again."
            )),
            node_version: (!node_output.is_empty()).then_some(node_output),
        };
    }
    DaemonRuntimeCapability {
        available: true,
        reason: None,
        node_version: (!node_output.is_empty()).then_some(node_output),
    }
}

#[cfg(desktop)]
fn daemon_failure_message(stdout: &str, stderr: &str) -> String {
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        "The daemon process exited before it reported a reason."
    };
    format!("The daemon couldn't start: {detail}")
}

#[cfg(desktop)]
async fn probe_runtime_command(
    command: &'static str,
    environment: Vec<(String, String)>,
) -> Result<String, String> {
    let mut process = Command::new(executable(command));
    process.env_clear().envs(environment).arg("--version");
    let output = run_process(
        process,
        RUNTIME_PROBE_TIMEOUT,
        format!("{command} did not respond within 5 seconds"),
    )
    .await
    .map_err(|error| {
        if error.contains("did not respond") {
            error
        } else {
            format!("{command} was not found")
        }
    })?;
    if !output.success {
        return Err(format!("{command} could not run"));
    }
    Ok(output.stdout)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_runtime_capability() -> DaemonRuntimeCapability {
    let environment = match resolve_environment().await {
        Ok(environment) => environment,
        Err(reason) => {
            return DaemonRuntimeCapability {
                available: false,
                reason: Some(reason),
                node_version: None,
            }
        }
    };
    let (node, npm) = tokio::join!(
        probe_runtime_command("node", environment.clone()),
        probe_runtime_command("npm", environment),
    );
    evaluate_runtime_capability(node, npm)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_pair(
    machine_key: String,
    machine_id: Option<String>,
) -> Result<CommandResult, String> {
    let args = daemon_pair_args(&machine_key, machine_id.as_deref(), cfg!(debug_assertions))?;
    let output = run_daemon(&args).await?;
    if output.success {
        Ok(CommandResult {
            success: true,
            message: "Daemon paired and started".to_string(),
        })
    } else {
        Ok(CommandResult {
            success: false,
            message: daemon_failure_message(&output.stdout, &output.stderr),
        })
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn runtime_capability_requires_node_and_npm() {
        let ok = || Ok("10.9.3".to_string());
        let old = evaluate_runtime_capability(Ok("v16.0.0".to_string()), ok());
        assert!(old.available);
        assert_eq!(old.node_version.as_deref(), Some("v16.0.0"));

        let unrecognized = evaluate_runtime_capability(Ok("not-a-version".to_string()), ok());
        assert!(unrecognized.available);

        let missing_npm = evaluate_runtime_capability(
            Ok("v22.0.0".to_string()),
            Err("npm was not found".to_string()),
        );
        assert!(!missing_npm.available);
        assert!(missing_npm.reason.unwrap().contains("npm was not found"));
    }

    #[test]
    fn daemon_failure_prefers_stderr_and_falls_back_to_stdout() {
        assert_eq!(
            daemon_failure_message("less useful stdout", "Node.js 20.9 or newer is required"),
            "The daemon couldn't start: Node.js 20.9 or newer is required"
        );
        assert_eq!(
            daemon_failure_message("npm failed", ""),
            "The daemon couldn't start: npm failed"
        );
        assert_eq!(
            daemon_failure_message("", ""),
            "The daemon couldn't start: The daemon process exited before it reported a reason."
        );
    }

    #[test]
    fn daemon_config_selects_repository_and_published_commands() {
        let debug = daemon_config_for(true);
        assert_eq!(debug.command, "pnpm");
        assert!(debug.base_args.is_empty());
        assert!(debug.cwd.is_some());

        let release = daemon_config_for(false);
        assert_eq!(release.command, "npm");
        assert_eq!(
            release.base_args,
            &[
                "exec",
                "--yes",
                "--package=@alook/daemon@latest",
                "--",
                "alook-daemon",
            ]
        );
        assert!(release.cwd.is_none());
    }

    #[test]
    fn release_pairing_uses_the_exact_published_bin_argv() {
        let key = "cmt_abcdefghijklmnopqrstuvwxyz012345";
        let extra = daemon_pair_args(key, Some("cm_abcdefgh"), false).unwrap();
        let cfg = daemon_config_for(false);
        assert_eq!(
            daemon_argv(&cfg, &extra),
            vec![
                "exec",
                "--yes",
                "--package=@alook/daemon@latest",
                "--",
                "alook-daemon",
                "daemon",
                "reconnect",
                "--id",
                "cm_abcdefgh",
                "--machine-key",
                key,
                "--server-url",
                "https://alook.ai",
                "--ws-url",
                "wss://alook.ai/api/ws/community-daemon",
            ]
        );
    }

    #[test]
    fn windows_uses_command_shims_for_node_package_tools() {
        assert_eq!(executable_for_platform("node", true), "node");
        assert_eq!(executable_for_platform("npm", true), "npm.cmd");
        assert_eq!(executable_for_platform("pnpm", true), "pnpm.cmd");
        assert_eq!(executable_for_platform("npm", false), "npm");
    }

    #[test]
    fn daemon_endpoints_are_fixed_at_the_native_boundary() {
        assert_eq!(
            daemon_endpoints_for(true),
            ("http://localhost:3000", "ws://localhost:8789")
        );
        assert_eq!(
            daemon_endpoints_for(false),
            ("https://alook.ai", "wss://alook.ai/api/ws/community-daemon")
        );
    }

    #[test]
    fn pairing_accepts_only_machine_keys_and_builds_fixed_arguments() {
        for key in [
            "cmt_abcdefghijklmnopqrstuvwxyz012345",
            "cmk_abcDEF0123456789_-abcdefghijklmn",
        ] {
            let args = daemon_pair_args(key, None, false).unwrap();
            assert_eq!(
                args,
                vec![
                    "daemon",
                    "start",
                    "--machine-key",
                    key,
                    "--server-url",
                    "https://alook.ai",
                    "--ws-url",
                    "wss://alook.ai/api/ws/community-daemon",
                ]
            );
            assert!(!args.iter().any(|arg| arg == "--base-dir"));
        }

        for invalid in [
            "cmt_too_short",
            "cmk_has spaces",
            "cm_machine_1234",
            "--server-url=https://example.com",
        ] {
            assert!(daemon_pair_args(invalid, None, false).is_err());
        }
    }

    #[test]
    fn reconnect_builds_exact_machine_arguments_and_rejects_invalid_ids() {
        let key = "cmt_abcdefghijklmnopqrstuvwxyz012345";
        let args = daemon_pair_args(key, Some("cm_abcdefgh"), false).unwrap();
        assert_eq!(
            &args[..6],
            [
                "daemon",
                "reconnect",
                "--id",
                "cm_abcdefgh",
                "--machine-key",
                key,
            ]
        );
        assert!(daemon_pair_args(key, Some("bad"), false).is_err());
        assert!(daemon_pair_args(
            "cmk_abcDEF0123456789_-abcdefghijklmn",
            Some("cm_abcdefgh"),
            false,
        )
        .is_err());
    }

    #[test]
    fn development_pairing_uses_only_fixed_local_endpoints() {
        let args = daemon_pair_args("cmt_abcdefghijklmnopqrstuvwxyz012345", None, true).unwrap();
        assert_eq!(args[5], "http://localhost:3000");
        assert_eq!(args[7], "ws://localhost:8789");
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn login_shell_path_accepts_only_one_line_of_absolute_entries() {
        let root = std::env::current_dir().unwrap();
        let first = root.join("runtime-path-one");
        let second = root.join("runtime-path-two");
        let valid = std::env::join_paths([first, second])
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(parse_shell_path(&valid).as_deref(), Some(valid.as_str()));
        assert!(parse_shell_path("").is_none());
        assert!(parse_shell_path("banner\n/usr/bin").is_none());
        assert!(parse_shell_path("relative/bin").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn shell_environment_retains_non_path_multiline_exports_without_inherited_noise() {
        let parsed = parse_shell_environment("banner\n__ALOOK_ENV_V1__\0PATH=/usr/bin:/bin\0HOME=/tmp/test\0SYNTHETIC=line1\n€€=$literal\0", false).unwrap();
        assert!(parsed.contains(&("SYNTHETIC".to_string(), "line1\n€€=$literal".to_string())));
        assert!(parse_shell_environment("PATH=/usr/bin", false).is_err());
        assert!(parse_shell_environment("__ALOOK_ENV_V1__\0PATH=/bin\0BAD\0", false).is_err());
    }

    #[test]
    fn configured_login_shell_uses_directory_service_or_passwd_output() {
        assert_eq!(
            parse_configured_shell("UserShell: /bin/zsh\n", true).as_deref(),
            Some("/bin/zsh")
        );
        assert_eq!(
            parse_configured_shell("test:x:1000:1000:Test:/home/test:/bin/bash\n", false)
                .as_deref(),
            Some("/bin/bash")
        );
        assert!(parse_configured_shell("UserShell: relative", true).is_none());
        assert!(parse_configured_shell("unexpected", false).is_none());
    }

    #[test]
    fn windows_environment_capture_uses_utf8_after_loading_profiles() {
        let command = shell_environment_command_for(
            vec![
                ("SystemRoot".into(), r"C:\Windows".into()),
                ("PRIVATE_OLD".into(), "stale".into()),
            ],
            true,
        );
        let script = command.get_args().last().unwrap().to_str().unwrap();
        assert!(
            script.find("Test-Path -LiteralPath").unwrap()
                < script
                    .find("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)")
                    .unwrap()
        );
        assert!(script.find("$machine.Keys").unwrap() < script.find("$login.Keys").unwrap());
        assert!(
            script.find("$login.Keys").unwrap() < script.find("Test-Path -LiteralPath").unwrap()
        );
        assert!(!command.get_envs().any(|(key, _)| key == "PRIVATE_OLD"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_login_shells_load_their_own_startup_configuration() {
        for name in ["bash", "zsh", "csh", "tcsh"] {
            let shell = PathBuf::from(format!("/bin/{name}"));
            if !shell.exists() {
                continue;
            }
            let root =
                std::env::temp_dir().join(format!("alook-login-env-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&root).unwrap();
            let files: Vec<(&str, &str)> = match name {
                "bash" => vec![
                    (
                        ".bash_profile",
                        "export ALOOK_LOGIN_PROFILE=loaded\n. \"$HOME/.bashrc\"\n",
                    ),
                    (".bashrc", "export ALOOK_INTERACTIVE_RC=loaded\n"),
                ],
                "zsh" => vec![
                    (".zprofile", "export ALOOK_LOGIN_PROFILE=loaded\n"),
                    (".zshrc", "export ALOOK_INTERACTIVE_RC=loaded\n"),
                ],
                _ => vec![
                    (".login", "setenv ALOOK_LOGIN_PROFILE loaded\n"),
                    (".cshrc", "setenv ALOOK_INTERACTIVE_RC loaded\n"),
                    (".tcshrc", "setenv ALOOK_INTERACTIVE_RC loaded\n"),
                ],
            };
            for (file, text) in files {
                std::fs::write(root.join(file), text).unwrap();
            }
            let command = shell_environment_command_for(
                vec![
                    ("SHELL".into(), shell.to_string_lossy().into_owned()),
                    ("HOME".into(), root.to_string_lossy().into_owned()),
                    ("ZDOTDIR".into(), root.to_string_lossy().into_owned()),
                    ("STALE_ONLY".into(), "old".into()),
                ],
                false,
            );
            let output =
                run_process_with_timeout(command, Duration::from_secs(2), "timeout".into())
                    .unwrap();
            assert!(output.success, "{name}");
            let environment = parse_shell_environment(&output.stdout, false).unwrap();
            assert!(
                environment.contains(&("ALOOK_LOGIN_PROFILE".into(), "loaded".into())),
                "{name}"
            );
            assert!(
                environment.contains(&("ALOOK_INTERACTIVE_RC".into(), "loaded".into())),
                "{name}"
            );
            assert!(!environment.iter().any(|(key, _)| key == "STALE_ONLY"));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_environment_capture_reaches_a_child_and_removes_stale_exports() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("alook-native-env-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let shell = root.join("shell");
        std::fs::write(&shell, "#!/bin/sh\nexport SYNTHETIC_FRESH='new value'\nprintf '__ALOOK_ENV_V1__\\000'\nexec /usr/bin/env -0\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        let command = shell_environment_command_for(
            vec![
                ("SHELL".to_string(), shell.to_string_lossy().to_string()),
                ("HOME".to_string(), root.to_string_lossy().to_string()),
                ("STALE_ONLY".to_string(), "old value".to_string()),
            ],
            false,
        );
        let output =
            run_process_with_timeout(command, Duration::from_secs(2), "timeout".to_string())
                .unwrap();
        assert!(output.success);
        let environment = parse_shell_environment(&output.stdout, false).unwrap();
        assert!(!environment.iter().any(|(key, _)| key == "STALE_ONLY"));
        let mut child = Command::new("/bin/sh");
        child.env_clear().envs(environment).args([
            "-c",
            "test \"$SYNTHETIC_FRESH\" = 'new value' && test -z \"$STALE_ONLY\"",
        ]);
        assert!(
            run_process_with_timeout(child, Duration::from_secs(2), "timeout".to_string())
                .unwrap()
                .success
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bounded_process_kills_a_stalled_process_group_holding_output_pipes() {
        let mut command = Command::new("sh");
        command.args(["-c", "(sh -c 'sleep 5') &"]);
        let started = Instant::now();
        let error = run_process_with_timeout(
            command,
            Duration::from_millis(50),
            "process timed out".to_string(),
        )
        .unwrap_err();

        assert_eq!(error, "process timed out");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

}
