import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { commandShimShell, execPackageManagerSync } from "../test-package-manager.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const machineId = "cm_self_update_real_123456";
const credential = "cmk_REAL_SELF_UPDATE_SECRET";
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-self-update-fixtures-"));
const baseDirs = new Set<string>();
let oldTgz = "";
let newTgz = "";

interface ReadyObservation {
  socket: WebSocket;
  frame: { type: "ready"; daemonVersion: string };
}

interface ControlServer {
  serverUrl: string;
  wsUrl: string;
  ready: ReadyObservation[];
  close(): Promise<void>;
}

function packFixture(version: string): string {
  const dir = path.join(fixtureRoot, `fixture-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(packageRoot, "dist"), path.join(dir, "dist"), { recursive: true });
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "@alook/daemon",
    version,
    type: "module",
    main: "./dist/index.js",
    bin: { "alook-daemon": "dist/cli/index.js" },
    files: ["dist"],
    engines: sourcePackage.engines,
    dependencies: sourcePackage.dependencies,
  }, null, 2));
  const packed = JSON.parse(execFileSync("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    fixtureRoot,
  ], {
    cwd: dir,
    encoding: "utf8",
    shell: commandShimShell(),
  })) as Array<{ filename: string }>;
  return path.join(fixtureRoot, packed[0]!.filename);
}

function runNpmPackage(
  tgz: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    execFile("npm", ["exec", "--yes", `--package=${tgz}`, "--", "alook-daemon", ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
      shell: commandShimShell(),
    }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code !== "number") {
        reject(error);
        return;
      }
      resolve({
        code: error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code
          : 0,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

async function createControlServer(): Promise<ControlServer> {
  const ready: ReadyObservation[] = [];
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/api/community/daemon/bots")) {
      response.end(JSON.stringify({ bots: [] }));
      return;
    }
    if (request.url?.includes("/api/community/daemon/wakes/resync")) {
      response.end(JSON.stringify({ woken: 0 }));
      return;
    }
    response.end(JSON.stringify({}));
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  wss.on("connection", (socket, request) => {
    expect(request.headers.authorization).toBe(`Bearer ${credential}`);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { type?: string; daemonVersion?: string };
      if (frame.type === "ready" && typeof frame.daemonVersion === "string") {
        ready.push({ socket, frame: frame as ReadyObservation["frame"] });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control server did not bind");
  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/control`,
    ready,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeBaseDir(control: ControlServer, latestPath: string): string {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-self-update-real-"));
  baseDirs.add(baseDir);
  const daemons = path.join(baseDir, "daemons");
  const daemonDir = path.join(daemons, machineId);
  fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(daemons, `${machineId}.credential.json`),
    JSON.stringify({ credential, machineId }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(daemonDir, "update-package-map.json"),
    JSON.stringify({ latest: latestPath, "9.9.0": oldTgz }),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(baseDir, "control.json"), JSON.stringify(control), { mode: 0o600 });
  return baseDir;
}

function pidfile(baseDir: string): string {
  return path.join(baseDir, "daemons", machineId, "daemon.pid");
}

function daemonDir(baseDir: string): string {
  return path.dirname(pidfile(baseDir));
}

function readOwner(baseDir: string): { pid: number; machineId: string; startedAt: string; ownerToken: string } {
  return JSON.parse(fs.readFileSync(pidfile(baseDir), "utf8"));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("self-update condition timed out");
}

async function startOld(baseDir: string, control: ControlServer): Promise<ReadyObservation> {
  const result = await runNpmPackage(oldTgz, [
    "daemon", "start",
    "--machine-key", credential,
    "--server-url", control.serverUrl,
    "--ws-url", control.wsUrl,
    "--base-dir", baseDir,
  ], { NODE_ENV: "test" });
  expect(result.code).toBe(0);
  expect(result.output).toContain("started in background");
  return await waitFor(() => control.ready.find((entry) => entry.frame.daemonVersion === "9.9.0"));
}

async function terminateCurrent(baseDir: string): Promise<void> {
  if (!fs.existsSync(pidfile(baseDir))) return;
  const owner = readOwner(baseDir);
  if (alive(owner.pid)) {
    try { process.kill(owner.pid, "SIGTERM"); } catch { /* best effort */ }
    await waitFor(() => !alive(owner.pid), 15_000).catch(() => {
      try { process.kill(owner.pid, "SIGKILL"); } catch { /* best effort */ }
      return true;
    });
  }
}

function updateEvents(baseDir: string): string[] {
  const logPath = path.join(daemonDir(baseDir), "update.log");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: string };
      return parsed.event ? [parsed.event] : [];
    } catch {
      return [];
    }
  });
}

async function waitForUpdateSettled(baseDir: string, timeoutMs = 45_000): Promise<void> {
  const intent = path.join(daemonDir(baseDir), "update-intent.json");
  const lock = path.join(daemonDir(baseDir), "daemon.replace.lock");
  try {
    await waitFor(() => !fs.existsSync(intent) && !fs.existsSync(lock), timeoutMs);
  } catch {
    throw new Error(JSON.stringify({
      error: "self-update helper did not settle",
      intentPresent: fs.existsSync(intent),
      replacementLockPresent: fs.existsSync(lock),
      events: updateEvents(baseDir),
      pidfilePresent: fs.existsSync(pidfile(baseDir)),
    }));
  }
}

beforeAll(() => {
  execPackageManagerSync(["run", "build"], { cwd: packageRoot, stdio: "pipe" });
  oldTgz = packFixture("9.9.0");
  newTgz = packFixture("9.9.1");
}, 120_000);

afterEach(async () => {
  for (const baseDir of baseDirs) await waitForUpdateSettled(baseDir);
  for (const baseDir of baseDirs) await terminateCurrent(baseDir);
  for (const baseDir of baseDirs) fs.rmSync(baseDir, { recursive: true, force: true });
  baseDirs.clear();
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("daemon self-update real package/process handoff", () => {
  it("upgrades 9.9.0 to 9.9.1 with a new PID and the same local identity", async () => {
    const control = await createControlServer();
    try {
      const baseDir = makeBaseDir(control, newTgz);
      const firstReady = await startOld(baseDir, control);
      const oldOwner = readOwner(baseDir);

      firstReady.socket.send(JSON.stringify({ type: "machine:update" }));

      const nextReady = await waitFor(() => control.ready.find((entry) => entry.frame.daemonVersion === "9.9.1"));
      expect(nextReady.frame.daemonVersion).toBe("9.9.1");
      const newOwner = await waitFor(() => {
        if (!fs.existsSync(pidfile(baseDir))) return false;
        const owner = readOwner(baseDir);
        return owner.pid !== oldOwner.pid ? owner : false;
      });
      expect(alive(oldOwner.pid)).toBe(false);
      expect(alive(newOwner.pid)).toBe(true);
      expect(newOwner.machineId).toBe(oldOwner.machineId);
      const record = JSON.parse(fs.readFileSync(path.join(baseDir, "daemons", `${machineId}.credential.json`), "utf8"));
      expect(record).toMatchObject({
        schemaVersion: 1,
        credential,
        machineId,
        serverUrl: control.serverUrl,
        wsUrl: control.wsUrl,
        daemonVersion: "9.9.1",
      });
      expect(updateEvents(baseDir)).toContain("replacement_ready");
      expect(fs.readFileSync(path.join(daemonDir(baseDir), "update.log"), "utf8")).not.toContain(credential);
    } finally {
      await control.close();
    }
  }, 120_000);

  it("keeps the old PID and socket live when latest maps to a missing tgz", async () => {
    const control = await createControlServer();
    try {
      const baseDir = makeBaseDir(control, path.join(fixtureRoot, "missing-latest.tgz"));
      const firstReady = await startOld(baseDir, control);
      const owner = readOwner(baseDir);

      firstReady.socket.send(JSON.stringify({ type: "machine:update" }));

      await waitFor(() => updateEvents(baseDir).includes("helper_spawn_requested"));
      await waitForUpdateSettled(baseDir);
      expect(readOwner(baseDir)).toEqual(owner);
      expect(alive(owner.pid)).toBe(true);
      expect(firstReady.socket.readyState).toBe(WebSocket.OPEN);
      expect(control.ready.filter((entry) => entry.frame.daemonVersion === "9.9.1")).toHaveLength(0);
    } finally {
      await control.close();
    }
  }, 120_000);

  it("rolls back exactly once to 9.9.0 when the new daemon cannot start", async () => {
    const control = await createControlServer();
    try {
      const baseDir = makeBaseDir(control, newTgz);
      const firstReady = await startOld(baseDir, control);
      const oldOwner = readOwner(baseDir);
      fs.writeFileSync(path.join(daemonDir(baseDir), "test-fail-start-9.9.1"), "1", { mode: 0o600 });

      firstReady.socket.send(JSON.stringify({ type: "machine:update" }));

      await waitFor(() => updateEvents(baseDir).includes("rollback_ready"));
      const rollbackReady = await waitFor(() => control.ready.filter((entry) => entry.frame.daemonVersion === "9.9.0")[1]);
      expect(rollbackReady.frame.daemonVersion).toBe("9.9.0");
      const rollbackOwner = readOwner(baseDir);
      expect(rollbackOwner.pid).not.toBe(oldOwner.pid);
      expect(alive(oldOwner.pid)).toBe(false);
      expect(alive(rollbackOwner.pid)).toBe(true);
      expect(updateEvents(baseDir).filter((event) => event === "replacement_start_failed")).toHaveLength(1);
      expect(updateEvents(baseDir).filter((event) => event === "rollback_ready")).toHaveLength(1);
    } finally {
      await control.close();
    }
  }, 120_000);

  it("bounds rollback to one attempt when both new start and rollback fail", async () => {
    const control = await createControlServer();
    try {
      const baseDir = makeBaseDir(control, newTgz);
      const firstReady = await startOld(baseDir, control);
      const oldOwner = readOwner(baseDir);
      fs.writeFileSync(path.join(daemonDir(baseDir), "test-fail-start-9.9.1"), "1", { mode: 0o600 });
      fs.writeFileSync(path.join(daemonDir(baseDir), "test-fail-start-9.9.0"), "1", { mode: 0o600 });

      firstReady.socket.send(JSON.stringify({ type: "machine:update" }));

      await waitFor(() => updateEvents(baseDir).includes("replacement_terminal_failure"));
      await waitFor(() => !fs.existsSync(path.join(daemonDir(baseDir), "daemon.replace.lock")));
      expect(alive(oldOwner.pid)).toBe(false);
      expect(fs.existsSync(pidfile(baseDir))).toBe(false);
      expect(updateEvents(baseDir).filter((event) => event === "replacement_start_failed")).toHaveLength(1);
      expect(updateEvents(baseDir).filter((event) => event === "replacement_terminal_failure")).toHaveLength(1);
      expect(control.ready.filter((entry) => entry.frame.daemonVersion === "9.9.1")).toHaveLength(0);
      expect(control.ready.filter((entry) => entry.frame.daemonVersion === "9.9.0")).toHaveLength(1);
    } finally {
      await control.close();
    }
  }, 120_000);
});
