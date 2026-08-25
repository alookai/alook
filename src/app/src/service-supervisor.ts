#!/usr/bin/env node
import { execFileSync, fork, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import {
  SUPERVISOR_ACQUISITION_BUDGET_MS,
  TERMINATION_BUDGET_MS,
  TERMINATION_GRACE_MS,
  WINDOWS_TREE_COMMAND_TIMEOUT_MS,
  type AuthorityStatus,
} from "./lib/control-authority.js";

interface BaseInit {
  runId: string;
  service: string;
  token: string;
  endpoint: string;
}

interface ReservationInit extends BaseInit {
  mode: "reservation";
  heartbeatPath: string;
}

interface ServiceInit extends BaseInit {
  mode: "service";
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type SupervisorInit = ReservationInit | ServiceInit;

interface CommandRunnerInit {
  mode: "command-runner";
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

let init: SupervisorInit | undefined;
type ManagedChild = ReturnType<typeof spawn> & EventEmitter;
type ManagedServer = Server & EventEmitter;

let server: ManagedServer | undefined;
let child: ManagedChild | undefined;
let commandRootPid: number | undefined;
const ownedWindowsProcesses = new Map<number, WindowsProcessRecord>();
let windowsSeedIdentitiesLocked = false;
let windowsProcessWatcher: ManagedChild | undefined;
let windowsProcessWatcherError: Error | undefined;
let windowsProcessWatcherStartedAt = 0n;
let windowsProcessWatcherWatermark = 0n;
let windowsSeedCutoff = 0n;
const pendingWindowsStartEvents: WindowsProcessStartEvent[] = [];
const latestWindowsStartEvents = new Map<number, WindowsProcessStartEvent>();
let treeSignalDelayConsumed = false;
let heartbeat: NodeJS.Timeout | undefined;
let status: AuthorityStatus = {
  ok: false,
  runId: "",
  service: "",
  supervisorPid: process.pid,
  childState: "starting",
};

function tokenMatches(candidate: unknown): boolean {
  if (!init || typeof candidate !== "string") return false;
  const expected = Buffer.from(init.token);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function posixTreeAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface WindowsProcessRecord {
  pid: number;
  parentPid: number;
  birth: string;
}

interface WindowsProcessStartEvent {
  pid: number;
  parentPid: number;
  eventTime: bigint;
  owned: boolean;
}

function windowsFileTimeNow(): bigint {
  return (BigInt(Date.now()) * 10_000n) + 116_444_736_000_000_000n;
}

function processWindowsStartEvent(event: WindowsProcessStartEvent): void {
  const parent = latestWindowsStartEvents.get(event.parentPid);
  event.owned ||= parent?.owned === true && parent.eventTime <= event.eventTime;
  latestWindowsStartEvents.set(event.pid, event);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of latestWindowsStartEvents.values()) {
      if (candidate.owned) continue;
      const candidateParent = latestWindowsStartEvents.get(candidate.parentPid);
      if (candidateParent?.owned && candidateParent.eventTime <= candidate.eventTime) {
        candidate.owned = true;
        changed = true;
      }
    }
  }
}

function recordWindowsStartEvent(value: unknown): void {
  const event = value as { pid?: unknown; parentPid?: unknown; eventTime?: unknown; watermark?: unknown };
  if (typeof event.watermark === "string") {
    const failureTrigger = process.env.ALOOK_APP_TEST_WINDOWS_WATCHER_FAILURE_TRIGGER;
    if (failureTrigger && existsSync(failureTrigger)) {
      if (process.env.ALOOK_APP_TEST_WINDOWS_WATCHER_FAILURE === "withhold-watermark") return;
      if (process.env.ALOOK_APP_TEST_WINDOWS_WATCHER_FAILURE === "exit") {
        windowsProcessWatcher?.kill();
        return;
      }
    }
    try {
      windowsProcessWatcherWatermark = BigInt(event.watermark);
      if (windowsSeedIdentitiesLocked) {
        for (const [pid, start] of latestWindowsStartEvents) {
          if (!start.owned || !pidAlive(pid)) latestWindowsStartEvents.delete(pid);
        }
      }
    } catch {
      windowsProcessWatcherError = new Error("Windows process watcher returned an invalid watermark");
    }
    return;
  }
  if (!Number.isInteger(event.pid) || !Number.isInteger(event.parentPid) || typeof event.eventTime !== "string") {
    windowsProcessWatcherError = new Error("Windows process watcher returned an invalid event");
    return;
  }
  let eventTime: bigint;
  try {
    eventTime = BigInt(event.eventTime);
  } catch {
    windowsProcessWatcherError = new Error("Windows process watcher returned an invalid creation time");
    return;
  }
  const record: WindowsProcessStartEvent = {
    pid: event.pid as number,
    parentPid: event.parentPid as number,
    eventTime,
    owned: false,
  };
  if (!windowsSeedIdentitiesLocked) pendingWindowsStartEvents.push(record);
  else processWindowsStartEvent(record);
}

async function startWindowsProcessWatcher(deadline: number): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$parentPid=${process.pid}`,
    "$query=New-Object System.Management.WqlEventQuery -ArgumentList 'SELECT ProcessID, ParentProcessID, TIME_CREATED FROM Win32_ProcessStartTrace'",
    "$watcher=New-Object System.Management.ManagementEventWatcher -ArgumentList $query",
    "$watcher.Options.Timeout=[TimeSpan]::FromMilliseconds(100)",
    "$watcher.Start()",
    "[Console]::Out.WriteLine('ready')",
    "[Console]::Out.Flush()",
    "try { while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { try { $event=$watcher.WaitForNextEvent(); [Console]::Out.WriteLine(([PSCustomObject]@{pid=[int]$event.ProcessID;parentPid=[int]$event.ParentProcessID;eventTime=[string]$event.TIME_CREATED}|ConvertTo-Json -Compress)) } catch [System.Management.ManagementException] { if ($_.Exception.ErrorCode -ne [System.Management.ManagementStatus]::Timedout) { throw }; [Console]::Out.WriteLine(([PSCustomObject]@{watermark=[string]([DateTime]::UtcNow.ToFileTimeUtc())}|ConvertTo-Json -Compress)) }; [Console]::Out.Flush() } } finally { $watcher.Stop(); $watcher.Dispose() }",
  ].join("; ");
  const watcher = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as ManagedChild;
  windowsProcessWatcher = watcher;
  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const timeoutMs = Math.max(1, Math.min(WINDOWS_TREE_COMMAND_TIMEOUT_MS, deadline - Date.now()));
    const timer = setTimeout(() => reject(new Error("Windows process watcher did not become ready")), timeoutMs);
    const fail = (error: Error) => {
      windowsProcessWatcherError = error;
      if (!ready) {
        clearTimeout(timer);
        reject(error);
      }
    };
    watcher.once("error", fail);
    watcher.once("exit", (code, signal) => fail(new Error(
      `Windows process watcher exited (${String(code ?? signal)})${stderr ? `: ${stderr.trim()}` : ""}`,
    )));
    watcher.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    watcher.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line === "ready") {
          ready = true;
          windowsProcessWatcherStartedAt = windowsFileTimeNow();
          windowsProcessWatcherWatermark = windowsProcessWatcherStartedAt;
          clearTimeout(timer);
          resolve();
        } else if (line) {
          try {
            recordWindowsStartEvent(JSON.parse(line));
          } catch {
            windowsProcessWatcherError = new Error("Windows process watcher returned invalid JSON");
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
  });
}

async function flushWindowsProcessWatcher(requiredWatermark = 0n, deadline = Date.now() + 5_000): Promise<void> {
  while (windowsProcessWatcherWatermark < requiredWatermark) {
    if (Date.now() >= deadline) throw new Error("Windows process watcher did not reach the required watermark");
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (windowsProcessWatcherError) throw windowsProcessWatcherError;
    if (!windowsProcessWatcher?.pid) throw new Error("Windows process watcher authority is missing");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (windowsProcessWatcherError) throw windowsProcessWatcherError;
  if (!windowsProcessWatcher?.pid) throw new Error("Windows process watcher authority is missing");
}

function windowsOperationTimeout(deadline?: number): number {
  if (deadline === undefined) return WINDOWS_TREE_COMMAND_TIMEOUT_MS;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("owned child tree termination deadline exceeded");
  return Math.max(1, Math.min(WINDOWS_TREE_COMMAND_TIMEOUT_MS, remaining));
}

function windowsProcessSnapshot(deadline?: number): WindowsProcessRecord[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=@(Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; birth=[string]($_.CreationDate.ToUniversalTime().ToFileTimeUtc()) } })",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: windowsOperationTimeout(deadline),
    windowsHide: true,
  }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  let records = values.map((value) => {
    const record = value as Partial<WindowsProcessRecord>;
    if (!Number.isInteger(record.pid) || !Number.isInteger(record.parentPid) || typeof record.birth !== "string") {
      throw new Error("Windows process snapshot returned an invalid record");
    }
    return { pid: record.pid!, parentPid: record.parentPid!, birth: record.birth };
  });
  if (
    windowsSeedIdentitiesLocked &&
    commandRootPid &&
    process.env.ALOOK_APP_TEST_REUSE_WINDOWS_COMMAND_ROOT_PID === "1"
  ) {
    records = records.filter((record) => record.pid !== commandRootPid);
    const injectedDescendantPid = Number(process.env.ALOOK_APP_TEST_REUSED_SEED_DESCENDANT_PID);
    const injectedDescendant = records.find((record) => record.pid === injectedDescendantPid);
    if (injectedDescendant) injectedDescendant.parentPid = commandRootPid;
  }
  return records;
}

function matchingWindowsStartEvent(record: WindowsProcessRecord): WindowsProcessStartEvent | undefined {
  const event = latestWindowsStartEvents.get(record.pid);
  return event && event.eventTime >= BigInt(record.birth) ? event : undefined;
}

async function refreshOwnedWindowsProcesses(
  deadline?: number,
  snapshot?: WindowsProcessRecord[],
): Promise<WindowsProcessRecord[]> {
  const records = snapshot ?? windowsProcessSnapshot(deadline);
  const reconciliationWatermark = windowsFileTimeNow();
  await flushWindowsProcessWatcher(reconciliationWatermark, deadline);
  const current = new Map(records.map((record) => [record.pid, record]));
  for (const [pid, owned] of ownedWindowsProcesses) {
    const record = current.get(pid);
    if (record && record.birth !== owned.birth) {
      throw new Error(`owned Windows process ${pid} identity changed`);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (ownedWindowsProcesses.has(record.pid)) continue;
      const start = matchingWindowsStartEvent(record);
      if (start?.owned) {
        ownedWindowsProcesses.set(record.pid, record);
        changed = true;
        continue;
      }
      const parent = ownedWindowsProcesses.get(record.parentPid);
      if (!parent) continue;
      const currentParent = current.get(record.parentPid);
      if (!currentParent) {
        throw new Error(`owned Windows parent ${record.parentPid} identity is unavailable`);
      }
      if (currentParent.birth !== parent.birth) {
        throw new Error(`owned Windows parent ${record.parentPid} identity changed`);
      }
      throw new Error(`owned Windows process ${record.pid} creation event is unavailable`);
    }
  }
  const liveOwned = records.filter((record) => ownedWindowsProcesses.get(record.pid)?.birth === record.birth);
  for (const pid of ownedWindowsProcesses.keys()) {
    if (!current.has(pid)) ownedWindowsProcesses.delete(pid);
  }
  return liveOwned;
}

async function lockOwnedWindowsSeeds(runnerPid: number, serviceRootPid: number, deadline: number): Promise<void> {
  await flushWindowsProcessWatcher(windowsSeedCutoff, deadline);
  const runnerSeeds = pendingWindowsStartEvents
    .filter((event) => (
      event.pid === runnerPid &&
      event.parentPid === process.pid &&
      event.eventTime >= windowsProcessWatcherStartedAt &&
      event.eventTime <= windowsSeedCutoff
    ))
    .sort((left, right) => left.eventTime < right.eventTime ? 1 : -1);
  const seedPair = runnerSeeds
    .map((runner) => ({
      runner,
      serviceRoot: pendingWindowsStartEvents
        .filter((event) => (
          event.pid === serviceRootPid &&
          event.parentPid === runnerPid &&
          event.eventTime >= runner.eventTime &&
          event.eventTime <= windowsSeedCutoff
        ))
        .sort((left, right) => left.eventTime < right.eventTime ? 1 : -1)[0],
    }))
    .find((candidate) => candidate.serviceRoot);
  if (!seedPair?.serviceRoot) {
    throw new Error("owned Windows process creation identity was not observed before acquisition");
  }
  seedPair.runner.owned = true;
  seedPair.serviceRoot.owned = true;
  for (const event of pendingWindowsStartEvents.sort((left, right) => left.eventTime < right.eventTime ? -1 : 1)) {
    processWindowsStartEvent(event);
  }
  pendingWindowsStartEvents.length = 0;
  windowsSeedIdentitiesLocked = true;
  const records = windowsProcessSnapshot(deadline);
  await refreshOwnedWindowsProcesses(deadline, records);
}

async function ownedTreeAlive(pid: number, deadline?: number): Promise<boolean> {
  if (process.platform !== "win32") return posixTreeAlive(pid);
  return (await refreshOwnedWindowsProcesses(deadline)).length > 0;
}

async function waitForTreeSignalBarrier(deadline: number): Promise<void> {
  const delayMs = Number(process.env.ALOOK_APP_TEST_TREE_SIGNAL_DELAY_MS ?? 0);
  if (!treeSignalDelayConsumed && Number.isFinite(delayMs) && delayMs > 0) {
    treeSignalDelayConsumed = true;
    if (Date.now() + delayMs >= deadline) throw new Error("tree signal test delay exceeds termination deadline");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const barrier = process.env.ALOOK_APP_TEST_TREE_SIGNAL_BARRIER;
  if (!barrier) return;
  writeFileSync(barrier, "ready\n");
  const release = `${barrier}.release`;
  const barrierDeadline = Math.min(deadline, Date.now() + 5_000);
  while (!existsSync(release)) {
    if (Date.now() >= barrierDeadline) throw new Error("tree signal test barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function signalTree(pid: number, force: boolean, deadline: number): Promise<unknown> {
  try {
    await waitForTreeSignalBarrier(deadline);
    if (force && process.env.ALOOK_APP_TEST_FORCE_TREE_SIGNAL_ERROR === "1") {
      return new Error("simulated forced tree signal failure");
    }
    if (process.platform === "win32") {
      const live = await refreshOwnedWindowsProcesses(deadline);
      const livePids = new Set(live.map((record) => record.pid));
      const targets = force
        ? live.filter((record) => !livePids.has(record.parentPid)).map((record) => record.pid)
        : [pid];
      const errors: unknown[] = [];
      for (const target of targets) {
        try {
          const args = ["/T", "/PID", String(target)];
          if (force) args.unshift("/F");
          execFileSync("taskkill", args, {
            stdio: "ignore",
            timeout: windowsOperationTimeout(deadline),
            windowsHide: true,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      return errors.length > 0 ? new Error(errors.map(String).join("; ")) : undefined;
    }
    if (force) process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGTERM");
    return undefined;
  } catch (error) {
    return error;
  }
}

async function waitForTreeExit(pid: number, timeoutMs: number, terminationDeadline: number): Promise<boolean> {
  const deadline = Math.min(terminationDeadline, Date.now() + timeoutMs);
  if (process.platform === "win32") {
    while (Date.now() < deadline) {
      if (![...ownedWindowsProcesses].some(([ownedPid]) => pidAlive(ownedPid))) {
        return (await refreshOwnedWindowsProcesses(terminationDeadline)).length === 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return (await refreshOwnedWindowsProcesses(terminationDeadline)).length === 0;
  }
  while (Date.now() < deadline) {
    if (!(await ownedTreeAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await ownedTreeAlive(pid));
}

async function terminateOwnedTree(): Promise<AuthorityStatus> {
  if (!child?.pid) throw new Error("original child authority is missing");
  const childPid = child.pid;
  const deadline = Date.now() + TERMINATION_BUDGET_MS;
  if (!(await ownedTreeAlive(childPid, deadline))) {
    status = { ...status, childState: "stopped" };
    return status;
  }
  const gracefulError = await signalTree(childPid, false, deadline);
  if (!(await waitForTreeExit(childPid, TERMINATION_GRACE_MS, deadline))) {
    if (child.pid !== childPid) {
      throw new Error("original child identity changed before escalation");
    }
    const forceError = await signalTree(childPid, true, deadline);
    if (!(await waitForTreeExit(childPid, TERMINATION_GRACE_MS, deadline))) {
      const errors = [gracefulError, forceError].filter(Boolean).map(String).join("; ");
      throw new Error(`owned child tree ${childPid} survived forced termination${errors ? `: ${errors}` : ""}`);
    }
  }
  status = { ...status, childState: "stopped" };
  return status;
}

function cleanupEndpoint(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  windowsProcessWatcher?.kill();
  windowsProcessWatcher = undefined;
  server?.close();
  server = undefined;
  if (init && process.platform !== "win32" && existsSync(init.endpoint)) {
    rmSync(init.endpoint, { force: true });
  }
}

function respond(socket: import("node:net").Socket, value: AuthorityStatus): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

function startControlServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!init) return reject(new Error("missing supervisor init"));
    if (process.platform !== "win32" && existsSync(init.endpoint)) rmSync(init.endpoint, { force: true });
    server = createServer((socket) => {
      let buffer = "";
      socket.setTimeout(2_000, () => socket.destroy());
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const request = JSON.parse(buffer.slice(0, newline)) as { token?: unknown; action?: unknown };
          if (!tokenMatches(request.token)) {
            respond(socket, { ...status, ok: false, error: "authority token mismatch" });
            return;
          }
          socket.setTimeout(0);
          if (request.action === "status") {
            respond(socket, { ...status, ok: true });
            return;
          }
          if (request.action === "release" && init?.mode === "reservation") {
            respond(socket, { ...status, ok: true, childState: "stopped" });
            setImmediate(() => {
              cleanupEndpoint();
              process.exit(0);
            });
            return;
          }
          if (request.action === "release" && init?.mode === "service" && status.childState !== "running") {
            void (async () => {
              if (child?.pid && await ownedTreeAlive(child.pid)) {
                throw new Error(`owned child tree ${child.pid} is still running`);
              }
              respond(socket, { ...status, ok: true, childState: "stopped" });
              setImmediate(() => {
                cleanupEndpoint();
                process.exit(0);
              });
            })().catch((error) => respond(socket, { ...status, ok: false, error: String(error) }));
            return;
          }
          if (request.action === "terminate" && init?.mode === "service") {
            void terminateOwnedTree()
              .then((value) => {
                respond(socket, { ...value, ok: true });
                setImmediate(() => {
                  cleanupEndpoint();
                  process.exit(0);
                });
              })
              .catch((error) => respond(socket, { ...status, ok: false, error: String(error) }));
            return;
          }
          respond(socket, { ...status, ok: false, error: "unsupported authority action" });
        } catch (error) {
          respond(socket, { ...status, ok: false, error: String(error) });
        }
      });
    }) as ManagedServer;
    server.once("error", reject);
    server.listen(init.endpoint, resolve);
  });
}

function emit(message: unknown): void {
  if (process.connected && process.send) process.send(message, () => {});
}

async function start(nextInit: SupervisorInit): Promise<void> {
  init = nextInit;
  status = {
    ok: true,
    runId: init.runId,
    service: init.service,
    supervisorPid: process.pid,
    childState: init.mode === "reservation" ? "running" : "starting",
  };
  await startControlServer();

  if (init.mode === "reservation") {
    const beat = () => writeFileSync(init!.mode === "reservation" ? init!.heartbeatPath : "", String(Date.now()), { mode: 0o600 });
    beat();
    heartbeat = setInterval(beat, 1_000);
    heartbeat.unref();
    emit({ type: "acquired", status });
    return;
  }

  const acquisitionDeadline = Date.now() + SUPERVISOR_ACQUISITION_BUDGET_MS;
  if (process.platform === "win32") await startWindowsProcessWatcher(acquisitionDeadline);

  child = fork(fileURLToPath(import.meta.url), [], {
    detached: true,
    execArgv: [],
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: process.env,
  }) as ManagedChild;
  child.once("error", (error) => {
    status = { ...status, childState: "error", error: error.message };
    emit({ type: "child-error", status });
  });
  child.once("exit", (code, signal) => {
    if (status.childState === "stopped") return;
    status = { ...status, childState: "exited", exitCode: code, exitSignal: signal };
    emit({ type: "child-exit", status });
  });
  child.on("message", (message) => {
    const payload = message as { type?: string; exitCode?: number | null; exitSignal?: NodeJS.Signals | null };
    if (payload.type !== "runner-command-exit" || status.childState === "stopped") return;
    status = {
      ...status,
      childState: "exited",
      exitCode: payload.exitCode,
      exitSignal: payload.exitSignal,
    };
    emit({ type: "child-exit", status });
  });
  if (!child.pid) throw new Error(`failed to spawn ${init.service} command runner`);
  commandRootPid = await new Promise<number>((resolve, reject) => {
    const timeoutMs = Math.max(1, Math.min(WINDOWS_TREE_COMMAND_TIMEOUT_MS, acquisitionDeadline - Date.now()));
    const timer = setTimeout(() => reject(new Error(`${init?.service ?? "service"} command runner did not start`)), timeoutMs);
    child!.once("error", reject);
    child!.once("exit", (code, signal) => reject(new Error(`command runner exited (${String(code ?? signal)}) before acquisition`)));
    child!.on("message", (message) => {
      const payload = message as { type?: string; error?: string; childPid?: number };
      if (payload.type === "runner-error") {
        clearTimeout(timer);
        reject(new Error(payload.error ?? "command runner failed"));
      }
      if (payload.type === "runner-acquired" && Number.isInteger(payload.childPid)) {
        clearTimeout(timer);
        windowsSeedCutoff = windowsFileTimeNow();
        resolve(payload.childPid!);
      }
    });
    child!.send({
      mode: "command-runner",
      command: init!.mode === "service" ? init!.command : "",
      args: init!.mode === "service" ? init!.args : [],
      cwd: init!.mode === "service" ? init!.cwd : process.cwd(),
      env: init!.mode === "service" ? init!.env : process.env,
    } satisfies CommandRunnerInit);
  });
  if (process.platform === "win32") {
    await lockOwnedWindowsSeeds(child.pid, commandRootPid, acquisitionDeadline);
  }
  status = { ...status, childPid: child.pid, childState: "running" };
  emit({ type: "acquired", status });
}

function startCommandRunner(runner: CommandRunnerInit): void {
  const command = spawn(runner.command, runner.args, {
    cwd: runner.cwd,
    detached: false,
    stdio: "inherit",
    env: runner.env,
    windowsHide: true,
  }) as ManagedChild;
  let forwarding = false;
  let commandExited = false;
  const forwardGracefulStop = () => {
    if (forwarding) return;
    forwarding = true;
    if (commandExited) process.exit(0);
    else if (command.pid) command.kill("SIGINT");
  };
  process.once("SIGTERM", forwardGracefulStop);
  process.once("SIGINT", forwardGracefulStop);
  command.once("error", (error) => {
    emit({ type: "runner-error", error: error.message });
    if (process.connected) process.disconnect?.();
    process.exit(1);
  });
  command.once("exit", (code, signal) => {
    commandExited = true;
    emit({ type: "runner-command-exit", exitCode: code, exitSignal: signal });
    if (forwarding) process.exit(code ?? (signal ? 1 : 0));
  });
  if (!command.pid) throw new Error("command runner failed to spawn its service root");
  emit({ type: "runner-acquired", childPid: command.pid });
}

process.once("message", (message) => {
  const next = message as SupervisorInit | CommandRunnerInit;
  if (next.mode === "command-runner") {
    try {
      startCommandRunner(next);
    } catch (error) {
      emit({ type: "runner-error", error: String(error) });
      process.exitCode = 1;
    }
    return;
  }
  void start(next).catch((error) => {
    status = { ...status, ok: false, childState: "error", error: String(error) };
    emit({ type: "supervisor-error", status });
    cleanupEndpoint();
    process.exitCode = 1;
  });
});

process.once("disconnect", () => {
  if (init?.mode === "reservation") {
    cleanupEndpoint();
    process.exit(0);
  }
});
