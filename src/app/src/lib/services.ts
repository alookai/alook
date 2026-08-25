import { fork } from "node:child_process";
import type { EventEmitter } from "node:events";
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveMode } from "@alook/shared";
import {
  SELF_HOSTED_DIR,
  SERVICE_NAMES,
  type ServiceName,
  type ServicePortProfile,
} from "./constants.js";
import {
  createAuthorityToken,
  createControlEndpoint,
  requestAuthority,
  SUPERVISOR_ACQUISITION_BUDGET_MS,
  supervisorEntryPath,
  type AuthorityStatus,
  type ControlAuthority,
} from "./control-authority.js";
import {
  clearRegistry,
  isAlive,
  readRegistry,
  readRegistryText,
  writeRegistry,
  type ServiceRegistry,
  type ServiceRegistryEntry,
} from "./pid.js";
import { checkPort } from "./checks.js";
import { wranglerProcess } from "./wrangler.js";

interface StartOptions {
  foreground?: boolean;
  onHandle?: (handle: OwnedServiceHandle) => void;
}

interface ServiceCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface SupervisorHandle {
  child: ManagedChild;
  entry: ServiceRegistryEntry;
  failure: Promise<AuthorityStatus>;
}

type ManagedChild = ReturnType<typeof fork> & EventEmitter;

const FAILURE_LOG_TAIL_BYTES = 64 * 1024;

function failureLogTail(logPath: string): string {
  try {
    const contents = readFileSync(logPath);
    return contents.subarray(Math.max(0, contents.length - FAILURE_LOG_TAIL_BYTES)).toString().trim();
  } catch {
    return "";
  }
}

export interface OwnedServiceHandle {
  runId: string;
  profile: ServicePortProfile;
  registry: ServiceRegistry;
  supervisors: Partial<Record<ServiceName, SupervisorHandle>>;
  foreground: boolean;
}

export type ServiceInspection =
  | { state: "none" }
  | { state: "stale"; registry: ServiceRegistry }
  | { state: "reusable"; registry: ServiceRegistry }
  | { state: "profile-mismatch" | "partial" | "recovery-required"; registry?: ServiceRegistry; detail: string };

const isDevMode =
  resolveMode({ nodeEnv: process.env.NODE_ENV }) === "dev" &&
  !!process.env.ALOOK_PROJECT_ROOT;

function logDir(): string {
  const dir = join(SELF_HOSTED_DIR, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function healthUrl(name: ServiceName, profile: ServicePortProfile): string {
  const path = name === "web" ? "/api/health" : "/health";
  return `http://127.0.0.1:${profile[name].business}${path}`;
}

function serviceDirectory(name: ServiceName): string {
  if (name === "emailWorker") return "email-worker";
  if (name === "wsDo") return "ws-do";
  if (name === "wakeWorker") return "wake-worker";
  return "web";
}

export function createServiceCommand(name: ServiceName, profile: ServicePortProfile): ServiceCommand {
  const ports = profile[name];
  const persistTo = ["--persist-to", join(SELF_HOSTED_DIR, "web", ".wrangler", "state")];
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };

  if (isDevMode) {
    const root = process.env.ALOOK_PROJECT_ROOT!;
    const cwd = join(root, "src", serviceDirectory(name));
    if (name === "web") {
      return {
        command: "npx",
        args: ["next", "dev", "--port", String(ports.business)],
        cwd,
        env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --inspect=127.0.0.1:${ports.inspector}`.trim() },
      };
    }
    return {
      command: "npx",
      args: ["wrangler", "dev", "--local", "--port", String(ports.business), "--inspector-port", String(ports.inspector), ...persistTo],
      cwd,
      env,
    };
  }

  const wrangler = wranglerProcess([
    "dev",
    "--local",
    "--port",
    String(ports.business),
    "--inspector-port",
    String(ports.inspector),
    ...persistTo,
  ]);
  return {
    command: wrangler.command,
    args: wrangler.args,
    cwd: join(SELF_HOSTED_DIR, serviceDirectory(name)),
    env,
  };
}

function sameProfile(left: ServicePortProfile, right: ServicePortProfile): boolean {
  return SERVICE_NAMES.every(
    (name) => left[name].business === right[name].business && left[name].inspector === right[name].inspector,
  );
}

function profileDiagnostic(profile: ServicePortProfile): string {
  return SERVICE_NAMES.map(
    (name) => `${name}=${profile[name].business}/${profile[name].inspector}`,
  ).join(", ");
}

function registryDiagnostic(registry: ServiceRegistry): string {
  const logs = SERVICE_NAMES.map(
    (name) => `${name} log=${registry.services[name]?.logPath ?? "missing"}`,
  ).join(", ");
  return `runId=${registry.runId}; profile ${profileDiagnostic(registry.profile)}; ${logs}`;
}

function statusMatchesEntry(
  status: AuthorityStatus,
  runId: string,
  name: ServiceName,
  entry: ServiceRegistryEntry,
): boolean {
  return status.runId === runId &&
    status.service === name &&
    status.supervisorPid === entry.authority.pid &&
    status.childPid === entry.childPid;
}

export function handleMatchesRegistry(
  handle: OwnedServiceHandle,
  registry = readRegistry(),
): registry is ServiceRegistry {
  if (!registry || registry.runId !== handle.runId) return false;
  return SERVICE_NAMES.every((name) => {
    const owned = handle.registry.services[name];
    const current = registry.services[name];
    if (!owned && !current) return true;
    return !!owned && !!current &&
      owned.authority.pid === current.authority.pid &&
      owned.authority.endpoint === current.authority.endpoint &&
      owned.authority.token === current.authority.token &&
      owned.childPid === current.childPid;
  });
}

async function launchServiceSupervisor(
  runId: string,
  name: ServiceName,
  profile: ServicePortProfile,
  foreground: boolean,
): Promise<SupervisorHandle> {
  const token = createAuthorityToken();
  const endpoint = createControlEndpoint(runId, name, token);
  const logPath = join(logDir(), `${name}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const stdio = foreground
    ? ["ignore", "pipe", "pipe", "ipc"]
    : ["ignore", logFd, logFd, "ipc"];
  const supervisor = fork(supervisorEntryPath(), [], {
    detached: true,
    execArgv: [],
    stdio: stdio as ["ignore", "pipe", "pipe", "ipc"] | ["ignore", number, number, "ipc"],
    env: process.env,
  }) as ManagedChild;
  closeSync(logFd);

  if (foreground) {
    const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
    supervisor.stdout?.on("data", (chunk) => {
      log.write(chunk);
      process.stdout.write(`[${name}] ${chunk.toString()}`);
    });
    supervisor.stderr?.on("data", (chunk) => {
      log.write(chunk);
      process.stderr.write(`[${name}] ${chunk.toString()}`);
    });
  }

  const command = createServiceCommand(name, profile);
  let resolveFailure!: (status: AuthorityStatus) => void;
  const failure = new Promise<AuthorityStatus>((resolve) => { resolveFailure = resolve; });

  return await new Promise((resolve, reject) => {
    let acquired = false;
    let acquisitionSettled = false;
    let failureSettled = false;
    const statusError = (label: string, nextStatus?: AuthorityStatus) => {
      const detail = nextStatus?.error ?? (
        nextStatus?.childState === "exited"
          ? `exit=${String(nextStatus.exitCode)} signal=${String(nextStatus.exitSignal)}`
          : ""
      );
      const tail = failureLogTail(logPath);
      return new Error(`${name} ${label}${detail ? `: ${detail}` : ""}; log=${logPath}${tail ? `\nstderr tail:\n${tail}` : ""}`);
    };
    const settleFailure = (nextStatus: AuthorityStatus) => {
      if (failureSettled) return;
      failureSettled = true;
      resolveFailure(nextStatus);
    };
    const fail = (error: Error) => {
      clearTimeout(timer);
      if (!acquired) {
        if (acquisitionSettled) return;
        acquisitionSettled = true;
        reject(error);
      } else settleFailure({
        ok: false,
        runId,
        service: name,
        supervisorPid: supervisor.pid ?? 0,
        childState: "error",
        error: error.message,
      });
    };
    const timer = setTimeout(() => {
      fail(statusError("supervisor did not acquire authority"));
      void requestAuthority({ pid: supervisor.pid ?? 0, endpoint, token }, "terminate", 1_000)
        .catch(() => { supervisor.kill(); });
    }, SUPERVISOR_ACQUISITION_BUDGET_MS + 2_000);
    supervisor.once("error", fail);
    supervisor.once("exit", (code, signal) => fail(new Error(`${name} supervisor exited (${String(code ?? signal)})`)));
    supervisor.once("disconnect", () => {
      if (!acquired) fail(statusError("supervisor IPC disconnected before acquisition"));
    });
    supervisor.on("message", (message) => {
      const payload = message as { type?: string; status?: AuthorityStatus };
      if (payload.type === "child-error" || payload.type === "child-exit" || payload.type === "supervisor-error") {
        if (!payload.status) {
          fail(statusError(`supervisor sent malformed ${payload.type}`));
          return;
        }
        if (!acquired) fail(statusError(payload.type, payload.status));
        else settleFailure(payload.status);
        return;
      }
      if (payload.type !== "acquired") return;
      if (!payload.status?.childPid) {
        fail(statusError("supervisor sent malformed acquired response", payload.status));
        return;
      }
      if (acquisitionSettled) return;
      acquisitionSettled = true;
      clearTimeout(timer);
      acquired = true;
      const authority: ControlAuthority = { pid: payload.status.supervisorPid, endpoint, token };
      resolve({
        child: supervisor,
        failure,
        entry: {
          name,
          authority,
          childPid: payload.status.childPid,
          childState: payload.status.childState,
          businessPort: profile[name].business,
          inspectorPort: profile[name].inspector,
          healthUrl: healthUrl(name, profile),
          logPath,
        },
      });
    });
    supervisor.send({
      mode: "service",
      runId,
      service: name,
      token,
      endpoint,
      ...command,
    });
  });
}

async function requestOwnedShutdown(entry: ServiceRegistryEntry): Promise<void> {
  await requestAuthority(entry.authority, "terminate");
}

export async function inspectServices(requested?: ServicePortProfile): Promise<ServiceInspection> {
  const raw = readRegistryText();
  const registry = readRegistry();
  if (!raw) return { state: "none" };
  if (!registry) return { state: "recovery-required", detail: "PID registry is malformed or from an unverifiable legacy owner" };

  let live = 0;
  const failures: string[] = [];
  for (const name of SERVICE_NAMES) {
    const entry = registry.services[name];
    if (!entry) {
      failures.push(`${name}: missing authority`);
      continue;
    }
    try {
      const status = await requestAuthority(entry.authority, "status");
      if (statusMatchesEntry(status, registry.runId, name, entry) && status.childState === "running") live += 1;
      else failures.push(`${name}: authority reports ${status.childState}`);
    } catch {
      if (isAlive(entry.authority.pid)) failures.push(`${name}: live PID without matching private authority`);
      else failures.push(`${name}: owner exited`);
    }
  }

  if (live === 0 && failures.every((item) => item.endsWith("owner exited") || item.endsWith("missing authority"))) {
    return { state: "stale", registry };
  }
  if (live !== SERVICE_NAMES.length || registry.phase !== "ready") {
    const reason = failures.join("; ") || `registry phase is ${registry.phase}`;
    return {
      state: registry.phase === "recovery-required" ? "recovery-required" : "partial",
      registry,
      detail: `${reason}; ${registryDiagnostic(registry)}`,
    };
  }
  if (requested && !sameProfile(registry.profile, requested)) {
    return {
      state: "profile-mismatch",
      registry,
      detail: `requested profile ${profileDiagnostic(requested)} does not match ${registryDiagnostic(registry)}`,
    };
  }
  return { state: "reusable", registry };
}

export async function startServices(profile: ServicePortProfile, opts: StartOptions = {}): Promise<OwnedServiceHandle> {
  const runId = randomUUID();
  const foreground = opts.foreground ?? false;
  const registry: ServiceRegistry = {
    version: 1,
    runId,
    phase: "starting",
    profile,
    services: {},
    createdAt: new Date().toISOString(),
  };
  const handle: OwnedServiceHandle = { runId, profile, registry, supervisors: {}, foreground };
  if (readRegistryText()) {
    throw new Error("refusing to overwrite an existing service registry; inspect or stop its owner first");
  }
  writeRegistry(registry);

  try {
    opts.onHandle?.(handle);
    for (const name of SERVICE_NAMES) {
      const supervisor = await launchServiceSupervisor(runId, name, profile, foreground);
      handle.supervisors[name] = supervisor;
      registry.services[name] = supervisor.entry;
      writeRegistry(registry);
    }
    return handle;
  } catch (error) {
    await terminateOwnedHandle(handle);
    throw error;
  }
}

export function markServicesReady(handle: OwnedServiceHandle): void {
  handle.registry.phase = "ready";
  writeRegistry(handle.registry);
  if (!handle.foreground) {
    for (const name of SERVICE_NAMES) {
      const child = handle.supervisors[name]?.child;
      child?.disconnect();
      child?.unref();
    }
  }
}

export async function terminateOwnedHandle(handle: OwnedServiceHandle): Promise<void> {
  if (!handleMatchesRegistry(handle)) {
    throw new Error(`service generation ${handle.runId} is no longer the current matching owner; refusing cleanup`);
  }
  const failures: string[] = [];
  for (const name of SERVICE_NAMES) {
    const entry = handle.registry.services[name];
    if (!entry) continue;
    try {
      const status = await requestAuthority(entry.authority, "status");
      if (!statusMatchesEntry(status, handle.runId, name, entry)) throw new Error("authority identity mismatch");
      await requestOwnedShutdown(entry);
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  }
  if (failures.length === 0) clearRegistry(handle.runId);
  else {
    handle.registry.phase = "recovery-required";
    writeRegistry(handle.registry);
    throw new Error(`could not clean owned services: ${failures.join("; ")}`);
  }
}

export async function stopServices(): Promise<{ stopped: boolean; errors: string[] }> {
  const registry = readRegistry();
  if (!registry) {
    return { stopped: false, errors: readRegistryText() ? ["PID registry is malformed or unverifiable"] : [] };
  }
  const errors: string[] = [];
  for (const name of SERVICE_NAMES) {
    const entry = registry.services[name];
    if (!entry) {
      errors.push(`${name}: missing private authority`);
      continue;
    }
    try {
      const status = await requestAuthority(entry.authority, "status");
      if (!statusMatchesEntry(status, registry.runId, name, entry)) throw new Error("private authority mismatch");
      await requestOwnedShutdown(entry);
    } catch (error) {
      errors.push(`${name} pid=${entry.authority.pid} endpoint=${entry.authority.endpoint}: ${String(error)}`);
    }
  }

  const ports = SERVICE_NAMES.flatMap((name) => [registry.profile[name].business, registry.profile[name].inspector]);
  const deadline = Date.now() + 5_000;
  while (errors.length === 0 && Date.now() < deadline) {
    const availability = await Promise.all(ports.map(checkPort));
    if (availability.every(Boolean)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (errors.length === 0 && !(await Promise.all(ports.map(checkPort))).every(Boolean)) {
    errors.push("one or more owned business/inspector ports remained occupied after stop");
  }

  if (errors.length > 0) {
    registry.phase = "recovery-required";
    writeRegistry(registry);
    return { stopped: false, errors };
  }
  clearRegistry(registry.runId);
  return { stopped: true, errors: [] };
}
