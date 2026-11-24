import { SELF_HOSTED_SERVICES } from "./service-topology.js";
import type { DevPortProfile } from "@alook/shared";
import { spawn, execSync, type ChildProcess } from "child_process";
import { join } from "path";
import { openSync, mkdirSync, closeSync } from "fs";
import { resolveMode } from "@alook/shared";
import { SELF_HOSTED_DIR } from "./constants.js";
import { writePids, readPids, isAlive, clearPids } from "./pid.js";
import { wranglerProcess } from "./wrangler.js";

interface StartOptions {
  foreground?: boolean;
}

const isDevMode =
  resolveMode({ nodeEnv: process.env.NODE_ENV }) === "dev" &&
  !!process.env.ALOOK_PROJECT_ROOT;

function logDir(): string {
  const dir = join(SELF_HOSTED_DIR, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function spawnService(name: string, cmd: string, args: string[], cwd: string, foreground: boolean): ChildProcess {
  if (foreground) {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
    });
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trimEnd();
      if (lines) console.log(`[${name}] ${lines}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trimEnd();
      if (lines) console.log(`[${name}] ${lines}`);
    });
    return child;
  }
  const logPath = join(logDir(), `${name}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, NODE_ENV: "development" },
  });
  child.unref();
  closeSync(logFd);
  return child;
}

function killProcess(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function startServices(ports: DevPortProfile, opts: StartOptions = {}): Promise<void> {
  const existing = readPids();
  const anyAlive = SELF_HOSTED_SERVICES.map((service) => existing[service.key]).some(
    (pid) => pid && isAlive(pid),
  );
  if (anyAlive) {
    console.log("Services already running. Use 'alook-app stop' first.");
    return;
  }

  const foreground = opts.foreground ?? false;
  console.log(`Starting services${foreground ? " (foreground)" : ""}...`);

  const persistTo = ["--persist-to", join(SELF_HOSTED_DIR, "web", ".wrangler", "state")];
  const processes = SELF_HOSTED_SERVICES.map((service) => {
    if (isDevMode) {
      const args = service.key === "web"
        ? ["next", "dev", "--port", String(ports.web)]
        : ["wrangler", "dev", "--local", "--port", String(ports[service.key]), ...persistTo];
      return { service, command: "npx", args, cwd: join(process.env.ALOOK_PROJECT_ROOT!, "src", service.directory) };
    }
    return {
      service,
      ...wranglerProcess(["dev", "--local", "--port", String(ports[service.key]), ...persistTo]),
      cwd: join(SELF_HOSTED_DIR, service.directory),
    };
  });
  const started = processes.map((record) => ({ ...record,
    child: spawnService(record.service.directory, record.command, record.args, record.cwd, foreground),
  }));

  const failed = started.filter(({ child }) => !child.pid);
  if (failed.length) {
    // A spawn failure arrives on the child's 'error' event one turn later;
    // without waiting for it, the exit below discards the real reason
    // (missing command, missing working directory) and nothing is logged.
    const reasons = await Promise.all(
      failed.map(({ child }) =>
        Promise.race<Error | undefined>([
          new Promise<Error | undefined>((resolve) => {
            child.once("error", resolve);
            child.once("spawn", () => resolve(undefined));
          }),
          new Promise<undefined>((resolve) => setImmediate(resolve)),
        ]),
      ),
    );
    console.error("Error: failed to start one or more services.");
    failed.forEach(({ service, command }, index) => {
      const detail = reasons[index]?.message ?? "process did not start";
      console.error(`  ${service.label}: could not run "${command}": ${detail}`);
    });
    for (const { child } of started) {
      if (child.pid) killProcess(child.pid);
    }
    process.exit(1);
  }

  const pids = Object.fromEntries(started.map(({ service, child }) => [service.key, child.pid!]));
  writePids({
    ...pids,
    ports: Object.fromEntries(SELF_HOSTED_SERVICES.map((service) => [service.key, ports[service.key]])),
  });

  for (const service of SELF_HOSTED_SERVICES) {
    const address = service.key === "web" ? `http://localhost:${ports.web}` : `port ${ports[service.key]}`;
    console.log(`  ${`${service.label}:`.padEnd(14)}${address} (pid=${pids[service.key]})`);
  }

  if (foreground) {
    let exiting = false;
    const cleanup = () => {
      if (exiting) return;
      exiting = true;
      console.log("\nStopping services...");
      for (const { child } of started) {
        if (child.pid) killProcess(child.pid);
      }
      clearPids();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}

export function stopServices(): void {
  const pids = readPids();
  let stopped = 0;

  for (const service of SELF_HOSTED_SERVICES) {
    const name = service.key;
    const pid = pids[name];
    if (pid && isAlive(pid)) {
      if (killProcess(pid)) {
        stopped++;
        console.log(`  Stopped ${name} (pid=${pid})`);
      } else {
        console.warn(`  Could not stop ${name} (pid=${pid})`);
      }
    }
  }

  if (stopped === 0) {
    console.log("No running services found.");
  }

  clearPids();
}

export function isRunning(): boolean {
  const pids = readPids();
  return SELF_HOSTED_SERVICES.map((service) => pids[service.key]).some(
    (pid) => pid && isAlive(pid),
  );
}
