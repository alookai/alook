import { spawn } from "node:child_process";
import * as path from "node:path";
import { userInfo } from "node:os";

const MARKER = "__ALOOK_ENV_V1__";
const MAX_BYTES = 1024 * 1024;
const BASE_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "ZDOTDIR", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "SystemRoot", "WINDIR", "COMSPEC", "USERPROFILE", "USERNAME", "USERDOMAIN", "ALLUSERSPROFILE", "PUBLIC", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"];

export function shellEnvironmentCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const baseline: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (BASE_KEYS.some((allowed) => allowed.toLowerCase() === key.toLowerCase())) baseline[key] = value;
  }
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    baseline.Path = path.win32.join(root, "System32");
    const script = "$ErrorActionPreference='Stop'; $machine=[Environment]::GetEnvironmentVariables('Machine'); $user=[Environment]::GetEnvironmentVariables('User'); foreach($k in $machine.Keys){[Environment]::SetEnvironmentVariable($k,[string]$machine[$k],'Process')}; foreach($k in $user.Keys){if($k -ne 'Path'){[Environment]::SetEnvironmentVariable($k,[string]$user[$k],'Process')}}; $env:Path=[Environment]::ExpandEnvironmentVariables(([string]$machine['Path'])+';'+([string]$user['Path'])); foreach($p in @($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost)){if(Test-Path -LiteralPath $p){. $p}}; $e=@{}; Get-ChildItem Env: | ForEach-Object {$e[$_.Name]=$_.Value}; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Out.Write('" + MARKER + "'+($e | ConvertTo-Json -Compress))";
    return { file: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], env: baseline };
  }
  baseline.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  const shell = env.SHELL || userInfo().shell || "/bin/sh";
  if (!path.isAbsolute(shell)) throw new Error("environment_unavailable");
  baseline.SHELL = shell;
  return { file: shell, args: ["-ilc", `printf '${MARKER}\\000'; exec /usr/bin/env -0`], env: baseline };
}

export function parseShellEnvironment(stdout: Buffer, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const marker = Buffer.from(MARKER + (platform === "win32" ? "" : "\0"));
  const offset = stdout.lastIndexOf(marker);
  if (offset < 0) throw new Error("environment_unavailable");
  const data = stdout.subarray(offset + marker.length).toString("utf8");
  const entries: Array<[string, unknown]> = platform === "win32"
    ? Object.entries(JSON.parse(data))
    : data.split("\0").filter(Boolean).map((entry) => {
      const split = entry.indexOf("=");
      if (split <= 0) throw new Error("environment_unavailable");
      return [entry.slice(0, split), entry.slice(split + 1)];
    });
  const result: NodeJS.ProcessEnv = Object.create(null);
  for (const [key, value] of entries) {
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("environment_unavailable");
    result[platform === "win32" ? key.toUpperCase() : key] = value;
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!result.PATH || !result[platform === "win32" ? "USERPROFILE" : "HOME"]
    || result.PATH.split(pathApi.delimiter).some((entry) => !pathApi.isAbsolute(entry.replace(/^"(.*)"$/, "$1")))) throw new Error("environment_unavailable");
  return result;
}

export async function readShellEnvironment(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; timeoutMs?: number; spawnProcess?: typeof spawn } = {}): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform;
  const command = shellEnvironmentCommand(options.env ?? process.env, platform);
  return await new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(command.file, command.args, { env: command.env, detached: platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const fail = (): void => {
      if (failed) return;
      failed = true;
      if (child.pid) {
        if (platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
    };
    const timeout = setTimeout(fail, options.timeoutMs ?? 5000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX_BYTES) fail();
      else chunks.push(data);
    });
    child.once("error", () => { clearTimeout(timeout); reject(new Error("environment_unavailable")); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failed || code !== 0) { reject(new Error("environment_unavailable")); return; }
      try { resolve(parseShellEnvironment(Buffer.concat(chunks), platform)); }
      catch { reject(new Error("environment_unavailable")); }
    });
  });
}
