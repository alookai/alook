import { spawn, execSync, type ChildProcess } from "child_process";
import { join } from "path";
import { openSync, mkdirSync, closeSync } from "fs";
import { SELF_HOSTED_DIR } from "./constants.js";
import { writePids, readPids, isAlive, clearPids } from "./pid.js";

interface ServicePorts {
  web: number;
  emailWorker: number;
  wsDo: number;
}

interface StartOptions {
  foreground?: boolean;
}

function isDevMode(): boolean {
  return !!process.env.ALOOK_PROJECT_ROOT;
}

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

export function startServices(ports: ServicePorts, opts: StartOptions = {}): void {
  const existing = readPids();
  const anyAlive = [existing.web, existing.emailWorker, existing.wsDo].some(
    (pid) => pid && isAlive(pid),
  );
  if (anyAlive) {
    console.log("Services already running. Use 'alook-app stop' first.");
    return;
  }

  const foreground = opts.foreground ?? false;
  console.log(`Starting services${foreground ? " (foreground)" : ""}...`);

  let webChild: ChildProcess;
  let emailChild: ChildProcess;
  let wsChild: ChildProcess;

  if (isDevMode()) {
    const root = process.env.ALOOK_PROJECT_ROOT!;
    const webDir = join(root, "src", "web");
    const emailDir = join(root, "src", "email-worker");
    const wsDir = join(root, "src", "ws-do");
    const persistTo = ["--persist-to", join(webDir, ".wrangler", "state")];

    webChild = spawnService("web", "npx", ["next", "dev", "--port", String(ports.web)], webDir, foreground);
    emailChild = spawnService("email-worker", "npx", ["wrangler", "dev", "--local", "--port", String(ports.emailWorker), ...persistTo], emailDir, foreground);
    wsChild = spawnService("ws-do", "npx", ["wrangler", "dev", "--local", "--port", String(ports.wsDo), ...persistTo], wsDir, foreground);
  } else {
    const persistTo = ["--persist-to", join(SELF_HOSTED_DIR, "web", ".wrangler", "state")];
    webChild = spawnService("web", "npx", ["wrangler", "dev", "--local", "--port", String(ports.web), ...persistTo], join(SELF_HOSTED_DIR, "web"), foreground);
    emailChild = spawnService("email-worker", "npx", ["wrangler", "dev", "--local", "--port", String(ports.emailWorker), ...persistTo], join(SELF_HOSTED_DIR, "email-worker"), foreground);
    wsChild = spawnService("ws-do", "npx", ["wrangler", "dev", "--local", "--port", String(ports.wsDo), ...persistTo], join(SELF_HOSTED_DIR, "ws-do"), foreground);
  }

  if (!webChild.pid || !emailChild.pid || !wsChild.pid) {
    console.error("Error: failed to start one or more services.");
    for (const child of [webChild, emailChild, wsChild]) {
      if (child.pid) killProcess(child.pid);
    }
    process.exit(1);
  }

  writePids({
    web: webChild.pid,
    emailWorker: emailChild.pid,
    wsDo: wsChild.pid,
    ports: {
      web: ports.web,
      emailWorker: ports.emailWorker,
      wsDo: ports.wsDo,
    },
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

  for (const [name, pid] of Object.entries(pids)) {
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
  return [pids.web, pids.emailWorker, pids.wsDo].some(
    (pid) => pid && isAlive(pid),
  );
}
