/**
 * Agent process spawn + process-tree termination with SIGKILL escalation.
 *
 * These two live together on purpose: they're opposite ends of the SAME
 * contract. `spawnAgentProcess` is the ONLY way a driver may start an agent
 * CLI — it always spawns `detached` on POSIX, making the child the leader of
 * its own process group (pgid = pid). That's what lets `killProcessTree`
 * signal the negative pid to reach the whole group — the CLI plus any MCP
 * servers / tool subprocesses it spawns — instead of just the leader, which
 * would otherwise leave grandchildren orphaned.
 *
 * BackendAdapter files must NOT call `child_process.spawn` directly for the agent CLI
 * — always go through `spawnAgentProcess` here, so the detached contract
 * can't be silently skipped by a new (or edited) driver.
 *
 * On POSIX, SIGTERM is a request and we escalate the process group to SIGKILL
 * after a grace window. On Windows, a kill-on-close Job Object holds the whole
 * tree even after a `.cmd`/runtime root exits; explicit stop uses `taskkill`
 * against that supervisor and the kernel job closes over any remaining child.
 */
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { PassThrough } from "node:stream";

const POLL_MS = 100;
const FORCE_EXIT_WAIT_MS = 2_000;
const TASKKILL_WAIT_MS = 2_000;
/**
 * Standard grace before SIGKILL when the manager stops a running session.
 * Every session-level stop path (logical stop, forced stop,
 * the process-lane stop fallback) shares this so the "how long
 * before we kill it hard" answer is one number, not three drifting ones.
 *
 * MUST stay strictly below `daemonStart.ts`'s `STOP_GRACE_MS` (the window
 * `alook daemon stop` gives the DAEMON before SIGKILLing it). The daemon's
 * SIGTERM handler awaits `manager.stopAll()`, which awaits these per-session
 * kills — so if the two windows were equal, an agent CLI that ignores SIGTERM
 * would still be inside its own grace when the outer SIGKILL lands, killing
 * the daemon before it ever escalates to SIGKILL on the child. The child is
 * detached (its own process group), so it would survive as an orphan.
 */
export const SESSION_STOP_GRACE_MS = 2000;
const DEFAULT_GRACE_MS = SESSION_STOP_GRACE_MS;
const isPosix = process.platform !== "win32";
const WINDOWS_JOB_NODE_ENV = "ALOOK_WINDOWS_JOB_NODE";
const WINDOWS_JOB_PAYLOAD_ENV = "ALOOK_WINDOWS_JOB_PAYLOAD";
const WINDOWS_JOB_RUNNER_ENV = "ALOOK_WINDOWS_JOB_RUNNER";
const WINDOWS_JOB_STDIN_PIPE_ENV = "ALOOK_WINDOWS_JOB_STDIN_PIPE";

function traceWindowsJob(env: NodeJS.ProcessEnv, phase: string): void {
  const path = env.ALOOK_WINDOWS_JOB_DEBUG_FILE;
  if (!path) return;
  try {
    appendFileSync(path, `${phase}\n`);
  } catch {
    // Diagnostic tracing must never alter process lifecycle.
  }
}

// The tracked Windows child is a PowerShell supervisor that owns a kill-on-close
// Job Object. It creates the inner Node process suspended, gives it the
// supervisor's raw output handles, assigns it to the job, and only then
// resumes it. Every descendant inherits the job, so the kernel retains tree
// authority after a `.cmd` shell or runtime root exits. Persistent protocol
// stdin uses a dedicated named pipe: PowerShell must not own that pipe because
// its host can block while probing stdin before it runs the encoded bootstrap.
const WINDOWS_JOB_RUNNER = "const{spawn}=require('node:child_process');const{appendFileSync}=require('node:fs');const{connect}=require('node:net');const debug=process.env.ALOOK_WINDOWS_JOB_DEBUG_FILE;const trace=m=>{if(debug)try{appendFileSync(debug,m+'\\n')}catch{}};trace('runner-start');const p=JSON.parse(Buffer.from(process.env.ALOOK_WINDOWS_JOB_PAYLOAD,'base64').toString('utf8'));const pipe=process.env.ALOOK_WINDOWS_JOB_STDIN_PIPE;delete process.env.ALOOK_WINDOWS_JOB_NODE;delete process.env.ALOOK_WINDOWS_JOB_PAYLOAD;delete process.env.ALOOK_WINDOWS_JOB_RUNNER;delete process.env.ALOOK_WINDOWS_JOB_STDIN_PIPE;const run=stdin=>{const c=spawn(p.command,p.args,{cwd:p.cwd,env:process.env,shell:p.shell,stdio:[stdin,'inherit','inherit'],windowsHide:true});c.once('spawn',()=>{trace('runtime-spawn');if(stdin!=='ignore')stdin.unref()});c.once('error',e=>{trace('runtime-error '+e.message);console.error(e);process.exitCode=1});c.once('exit',(code,signal)=>{trace('runtime-exit '+code+' '+signal);process.exitCode=signal?1:(code??1)})};if(pipe){const input=connect(pipe);input.once('connect',()=>{trace('runner-connect');run(input)});input.once('error',e=>{trace('runner-connect-error '+e.message);console.error(e);process.exitCode=1})}else run('ignore')";

const WINDOWS_JOB_BOOTSTRAP = String.raw`
$ErrorActionPreference = "Stop"
if ($env:ALOOK_WINDOWS_JOB_DEBUG_FILE) { try { Add-Content -LiteralPath $env:ALOOK_WINDOWS_JOB_DEBUG_FILE -Value "bootstrap-start" } catch {} }
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AlookAgentJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicAccountingInformation {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfo {
    public uint Size;
    public IntPtr Reserved;
    public IntPtr Desktop;
    public IntPtr Title;
    public uint X;
    public uint Y;
    public uint XSize;
    public uint YSize;
    public uint XCountChars;
    public uint YCountChars;
    public uint FillAttribute;
    public uint Flags;
    public ushort ShowWindow;
    public ushort Reserved2Size;
    public IntPtr Reserved2;
    public IntPtr StdInput;
    public IntPtr StdOutput;
    public IntPtr StdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr Process;
    public IntPtr Thread;
    public uint ProcessId;
    public uint ThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    ref ExtendedLimits information,
    uint informationLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    ref BasicAccountingInformation information,
    uint informationLength,
    IntPtr returnLength
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr GetStdHandle(int standardHandle);

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DuplicateHandle(
    IntPtr sourceProcess,
    IntPtr sourceHandle,
    IntPtr targetProcess,
    out IntPtr targetHandle,
    uint desiredAccess,
    bool inheritHandle,
    uint options
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static IntPtr CreateKillOnCloseJob() {
    const uint KillOnJobClose = 0x00002000;
    const int ExtendedLimitInformation = 9;
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
    var limits = new ExtendedLimits();
    limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits))) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new Win32Exception(error, "SetInformationJobObject failed");
    }
    return job;
  }

  private static string QuoteArgument(string value) {
    if (value.Length == 0) return "\"\"";
    if (value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
    var quoted = new StringBuilder("\"");
    int backslashes = 0;
    foreach (char character in value) {
      if (character == '\\') {
        backslashes++;
      } else if (character == '"') {
        quoted.Append('\\', backslashes * 2 + 1);
        quoted.Append('"');
        backslashes = 0;
      } else {
        quoted.Append('\\', backslashes);
        quoted.Append(character);
        backslashes = 0;
      }
    }
    quoted.Append('\\', backslashes * 2);
    quoted.Append('"');
    return quoted.ToString();
  }

  private static IntPtr DuplicateStandardHandle(int standardHandle) {
    const uint DuplicateSameAccess = 0x00000002;
    IntPtr source = GetStdHandle(standardHandle);
    if (source == IntPtr.Zero || source == new IntPtr(-1))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "GetStdHandle failed");
    IntPtr current = GetCurrentProcess();
    IntPtr duplicate;
    if (!DuplicateHandle(
      current,
      source,
      current,
      out duplicate,
      0,
      true,
      DuplicateSameAccess
    )) throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle failed");
    return duplicate;
  }

  private static void TerminateAndDrainJob(IntPtr job) {
    const int BasicAccounting = 1;
    if (!TerminateJobObject(job, 1))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
    DateTime deadline = DateTime.UtcNow.AddSeconds(5);
    while (true) {
      var accounting = new BasicAccountingInformation();
      if (!QueryInformationJobObject(
        job,
        BasicAccounting,
        ref accounting,
        (uint)Marshal.SizeOf(accounting),
        IntPtr.Zero
      )) throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
      if (accounting.ActiveProcesses == 0) return;
      if (DateTime.UtcNow >= deadline)
        throw new TimeoutException("Windows process job did not drain within 5000ms");
      Thread.Sleep(10);
    }
  }

  public static int RunNode(string nodePath, string runner) {
    const uint CreateSuspended = 0x00000004;
    const uint StartfUseStdHandles = 0x00000100;
    const uint Infinite = 0xffffffff;
    const uint WaitFailed = 0xffffffff;
    IntPtr stdInput = DuplicateStandardHandle(-10);
    IntPtr stdOutput = IntPtr.Zero;
    IntPtr stdError = IntPtr.Zero;
    IntPtr job = IntPtr.Zero;
    var startup = new StartupInfo();
    startup.Size = (uint)Marshal.SizeOf(startup);
    startup.Flags = StartfUseStdHandles;
    var commandLine = new StringBuilder(
      QuoteArgument(nodePath) + " -e " + QuoteArgument(runner)
    );
    ProcessInformation child;
    try {
      stdOutput = DuplicateStandardHandle(-11);
      stdError = DuplicateStandardHandle(-12);
      startup.StdInput = stdInput;
      startup.StdOutput = stdOutput;
      startup.StdError = stdError;
      job = CreateKillOnCloseJob();
      if (!CreateProcessW(
        nodePath,
        commandLine,
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        CreateSuspended,
        IntPtr.Zero,
        null,
        ref startup,
        out child
      )) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
      bool assigned = false;
      try {
        if (!AssignProcessToJobObject(job, child.Process))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
        assigned = true;
        if (ResumeThread(child.Thread) == uint.MaxValue)
          throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
        if (WaitForSingleObject(child.Process, Infinite) == WaitFailed)
          throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
        uint exitCode;
        if (!GetExitCodeProcess(child.Process, out exitCode))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
        if (!CloseHandle(child.Thread))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle child thread failed");
        child.Thread = IntPtr.Zero;
        if (!CloseHandle(child.Process))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle child process failed");
        child.Process = IntPtr.Zero;
        TerminateAndDrainJob(job);
        return unchecked((int)exitCode);
      } catch {
        if (!assigned && child.Process != IntPtr.Zero) TerminateProcess(child.Process, 1);
        throw;
      } finally {
        if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
        if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      }
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
      if (stdError != IntPtr.Zero) CloseHandle(stdError);
      if (stdOutput != IntPtr.Zero) CloseHandle(stdOutput);
      CloseHandle(stdInput);
    }
  }
}
"@
if ($env:ALOOK_WINDOWS_JOB_DEBUG_FILE) { try { Add-Content -LiteralPath $env:ALOOK_WINDOWS_JOB_DEBUG_FILE -Value "add-type-complete" } catch {} }
$exitCode = [AlookAgentJob]::RunNode($env:ALOOK_WINDOWS_JOB_NODE, $env:ALOOK_WINDOWS_JOB_RUNNER)
exit $exitCode
`;

const WINDOWS_JOB_ENCODED_COMMAND = Buffer.from(WINDOWS_JOB_BOOTSTRAP, "utf16le").toString("base64");

interface AgentSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Run through a shell — needed on Windows for `.cmd`/`.bat` shims. */
  shell?: boolean;
  /**
   * stdin disposition. Default `"pipe"` for persistent stdio transports. A
   * one-shot adapter that proves it never reads stdin may opt into `"ignore"`.
   * stdout/stderr stay piped regardless for protocol output and diagnostics.
   */
  stdin?: "pipe" | "ignore";
}

/**
 * The only sanctioned way to spawn an agent CLI child process. Always pipes
 * stdio and (on POSIX) spawns `detached` so the child becomes its own
 * process-group leader — required for `killProcessTree`'s group signal to
 * actually reach it (and its grandchildren) instead of silently no-oping.
 * See the module doc comment above for why this must be the single spawn
 * entry point rather than each driver calling `child_process.spawn` itself.
 */
export function spawnAgentProcess(command: string, args: string[], opts: AgentSpawnOptions): ChildProcess {
  if (!isPosix) {
    const stdin = opts.stdin ?? "pipe";
    const stdinProxy = stdin === "pipe" ? new PassThrough() : undefined;
    const stdinPipe = stdinProxy
      ? `\\\\.\\pipe\\alook-agent-${process.pid}-${randomUUID()}`
      : undefined;
    let stdinSocket: Socket | undefined;
    const stdinServer = stdinProxy
      ? createServer((socket) => {
          traceWindowsJob(opts.env, "stdin-server-connect");
          stdinSocket = socket;
          stdinServer?.close();
          socket.once("close", () => {
            if (stdinSocket === socket) stdinSocket = undefined;
          });
          socket.once("error", () => stdinProxy.destroy());
          stdinProxy.pipe(socket);
        })
      : undefined;
    stdinServer?.once("listening", () => traceWindowsJob(opts.env, "stdin-server-listening"));
    stdinProxy?.once("close", () => {
      if (!stdinProxy.writableFinished) stdinSocket?.destroy();
    });
    stdinServer?.once("error", () => stdinProxy?.destroy());
    if (stdinPipe) stdinServer?.listen(stdinPipe);
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      [WINDOWS_JOB_NODE_ENV]: process.execPath,
      [WINDOWS_JOB_PAYLOAD_ENV]: Buffer.from(JSON.stringify({ command, args, cwd: opts.cwd, shell: opts.shell ?? false })).toString("base64"),
      [WINDOWS_JOB_RUNNER_ENV]: WINDOWS_JOB_RUNNER,
      ...(stdinPipe ? { [WINDOWS_JOB_STDIN_PIPE_ENV]: stdinPipe } : {}),
    };
    traceWindowsJob(env, "spawn-called");
    let proc: ChildProcess;
    try {
      proc = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_JOB_ENCODED_COMMAND], {
        cwd: opts.cwd,
        // PowerShell receives NUL for stdin so its host cannot consume or
        // block the persistent protocol pipe before running the bootstrap.
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (error) {
      stdinServer?.close();
      stdinProxy?.destroy();
      throw error;
    }
    proc.once("spawn", () => traceWindowsJob(env, "powershell-spawn"));
    proc.once("error", (error) => traceWindowsJob(env, `powershell-error ${error.message}`));
    proc.once("exit", (code, signal) => traceWindowsJob(env, `powershell-exit ${String(code)} ${String(signal)}`));
    if (stdinProxy) Object.defineProperty(proc, "stdin", { value: stdinProxy });
    const closeStdinBridge = () => {
      if (stdinServer?.listening) stdinServer.close();
      stdinSocket?.destroy();
      stdinProxy?.destroy();
    };
    proc.once("error", closeStdinBridge);
    proc.once("exit", closeStdinBridge);
    return proc;
  }
  return spawn(command, args, {
    cwd: opts.cwd,
    // stdout/stderr always piped (we read stream-json/JSON-RPC); stdin defaults
    // to pipe for persistent transports. See AgentSpawnOptions.stdin.
    stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    env: opts.env,
    shell: opts.shell ?? false,
    detached: isPosix,
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isProcessGroupAlive(pid: number): boolean {
  if (!isPosix) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Best-effort group signal, ALWAYS followed by a direct pid signal —
 * regardless of whether the group signal succeeded, threw `ESRCH` (no such
 * process group — e.g. the child wasn't spawned detached), or threw anything
 * else. A group signal failure must never be mistaken for "the pid is dead":
 * that conflates two unrelated failure semantics and was the root cause of a
 * bug where stopped agents kept running forever (see
 * plans/fix-daemon-agent-process-kill.md). Signaling an already-dead pid is
 * safe — it just throws ESRCH too, caught and ignored below.
 */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (isPosix) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Most commonly ESRCH (no such process group — not detached, or
      // already gone), but any failure here falls through the same way:
      // never treat it as proof the pid itself is dead.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

/** Stop the live Windows job supervisor and await its forced tree walk. */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const settle = (result: "resolve" | "reject", error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result === "resolve") resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      killer.kill();
      settle("reject", new Error(`Windows process-tree termination timed out after ${TASKKILL_WAIT_MS}ms`));
    }, TASKKILL_WAIT_MS);
    timer.unref?.();
    killer.once("error", (error) => {
      settle("reject", new Error(`failed to launch Windows process-tree termination: ${error.message}`));
    });
    killer.once("close", (code, signal) => {
      if (code === 0) {
        settle("resolve");
        return;
      }
      settle(
        "reject",
        new Error(`Windows process-tree termination failed (exit=${String(code)}, signal=${String(signal)})`),
      );
    });
  });
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  // A single /T /F call snapshots and terminates the complete tree while the
  // wrapper pid is still alive. Killing the wrapper first would orphan the
  // actual runtime and make a later tree walk unable to discover it. Windows
  // has no safe recursive graceful-signal primitive, so start this immediately;
  // the controller separately owns the public force deadline.
  await taskkillTree(pid);
  await waitForProcessExit(pid, FORCE_EXIT_WAIT_MS);
  if (isAlive(pid)) throw new Error(`Windows process tree ${pid} remained alive after taskkill completed`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Terminate `pid` and its descendants: POSIX process-group signals with force
 * escalation after `graceMs`, or immediate Windows job-supervisor teardown.
 * A dead Windows supervisor has already closed its kill-on-close job.
 */
export async function killProcessTree(
  pid: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (!pid || pid < 1) return;
  if (!isPosix) {
    if (!isAlive(pid)) return;
    await killWindowsProcessTree(pid);
    return;
  }

  // A detached CLI owns a process group whose lifetime can outlast its root:
  // after TERM, the shell/runtime may exit while an MCP or tool descendant
  // ignores the signal. Once a group exists, it—not the root pid—is the stop
  // authority. Non-detached processes have no group at `-pid` and retain the
  // direct-pid fallback.
  const ownsProcessGroup = isProcessGroupAlive(pid);
  const targetIsAlive = ownsProcessGroup
    ? () => isProcessGroupAlive(pid)
    : () => isAlive(pid);
  if (!targetIsAlive()) return;

  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  signalTree(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targetIsAlive()) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (targetIsAlive()) {
    signalTree(pid, "SIGKILL");
    const forceDeadline = Date.now() + FORCE_EXIT_WAIT_MS;
    while (targetIsAlive() && Date.now() < forceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (targetIsAlive()) throw new Error(`POSIX process tree ${pid} remained alive after SIGKILL`);
  }
}
