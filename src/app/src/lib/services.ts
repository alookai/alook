import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { openSync, mkdirSync, closeSync } from "fs";
import { SELF_HOSTED_DIR } from "./constants.js";
import { writePids, readPids, isAlive } from "./pid.js";

interface ServicePorts {
  web: number;
  emailWorker: number;
  wsDo: number;
}

interface StartOptions {
  foreground?: boolean;
}

function logDir(): string {
  const dir = join(SELF_HOSTED_DIR, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function spawnBackground(name: string, cwd: string, port: number): ChildProcess {
  const logPath = join(logDir(), `${name}.log`);
  const logFd = openSync(logPath, "a", 0o600);

  const args = ["wrangler", "dev", "--local", "--port", String(port)];
  const child = spawn("npx", args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, NODE_ENV: "development" },
  });
  child.unref();
  closeSync(logFd);
  return child;
}

function spawnForeground(name: string, cwd: string, port: number): ChildProcess {
  const args = ["wrangler", "dev", "--local", "--port", String(port)];
  const child = spawn("npx", args, {
    cwd,
    detached: true,
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

export function startServices(ports: ServicePorts, opts: StartOptions = {}): void {
  const existing = readPids();
  if (existing.web && isAlive(existing.web)) {
    console.log("Services already running. Use 'alook-app stop' first.");
    return;
  }

  const foreground = opts.foreground ?? false;
  const spawnFn = foreground ? spawnForeground : spawnBackground;

  console.log(`Starting services${foreground ? " (foreground)" : ""}...`);

  const webChild = spawnFn("web", join(SELF_HOSTED_DIR, "web"), ports.web);
  const emailChild = spawnFn("email-worker", join(SELF_HOSTED_DIR, "email-worker"), ports.emailWorker);
  const wsChild = spawnFn("ws-do", join(SELF_HOSTED_DIR, "ws-do"), ports.wsDo);

  writePids({
    web: webChild.pid,
    emailWorker: emailChild.pid,
    wsDo: wsChild.pid,
  });

  console.log(`  Web:          http://localhost:${ports.web} (pid=${webChild.pid})`);
  console.log(`  Email Worker: port ${ports.emailWorker} (pid=${emailChild.pid})`);
  console.log(`  WS-DO:        port ${ports.wsDo} (pid=${wsChild.pid})`);

  if (foreground) {
    let exiting = false;
    const cleanup = () => {
      if (exiting) return;
      exiting = true;
      console.log("\nStopping services...");
      for (const child of [webChild, emailChild, wsChild]) {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch {}
        }
      }
      writePids({});
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", cleanup);
  }
}

export function stopServices(): void {
  const pids = readPids();
  let stopped = 0;

  for (const [name, pid] of Object.entries(pids)) {
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        stopped++;
        console.log(`  Stopped ${name} (pid=${pid})`);
      } catch {
        console.warn(`  Could not stop ${name} (pid=${pid})`);
      }
    }
  }

  if (stopped === 0) {
    console.log("No running services found.");
  }

  writePids({});
}

export function isRunning(): boolean {
  const pids = readPids();
  return !!(pids.web && isAlive(pids.web));
}
