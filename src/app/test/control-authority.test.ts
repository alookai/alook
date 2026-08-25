import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import {
  createAuthorityToken,
  createControlEndpoint,
  requestAuthority,
  SUPERVISOR_ACQUISITION_BUDGET_MS,
} from "../src/lib/control-authority.js";

const scratch = join(tmpdir(), `alook-control-authority-${process.pid}`);
const supervisorEntry = join(scratch, "service-supervisor.js");
const controlledSupervisorEntry = join(scratch, "service-supervisor-windows-controlled.js");
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const treeFixture = join(appRoot, "test/fixtures/process-tree-child.mjs");
const INTEGRATION_TEST_TIMEOUT_MS = SUPERVISOR_ACQUISITION_BUDGET_MS + 10_000;
const STDERR_TAIL_BYTES = 64 * 1024;

function testEndpoint(label: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\alook-control-test-${process.pid}-${label}`
    : join(scratch, `${label}.sock`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hostileWindowsPath(directory: string): NodeJS.ProcessEnv {
  const pathEntry = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path");
  return { [pathEntry?.[0] ?? "Path"]: `${directory};${pathEntry?.[1] ?? ""}` };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("condition did not become true");
}

async function launchOwnedTree(
  mode: "graceful" | "stubborn" | "orphan" | "late-orphan",
  options: {
    forceSignalError?: boolean;
    reuseWindowsCommandRootPid?: boolean;
    reusedSeedDescendantPid?: number;
    signalBarrier?: string;
    signalDelayMs?: number;
    terminationGraceMs?: number;
    terminationBudgetMs?: number;
    watcherFailure?: "exit" | "withhold-marker";
    watcherFailureTrigger?: string;
    entry?: string;
    supervisorEnv?: NodeJS.ProcessEnv;
  } = {},
) {
  const token = createAuthorityToken();
  const runId = `run-${mode}-${Date.now()}`;
  const endpoint = createControlEndpoint(runId, "web", token);
  const pidFile = join(scratch, `${runId}.json`);
  const supervisor = fork(options.entry ?? supervisorEntry, [], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ALOOK_APP_TERMINATION_GRACE_MS: String(options.terminationGraceMs ?? 100),
      ...(options.forceSignalError ? { ALOOK_APP_TEST_FORCE_TREE_SIGNAL_ERROR: "1" } : {}),
      ...(options.reuseWindowsCommandRootPid ? { ALOOK_APP_TEST_REUSE_WINDOWS_COMMAND_ROOT_PID: "1" } : {}),
      ...(options.reusedSeedDescendantPid
        ? { ALOOK_APP_TEST_REUSED_SEED_DESCENDANT_PID: String(options.reusedSeedDescendantPid) }
        : {}),
      ...(options.signalBarrier ? { ALOOK_APP_TEST_TREE_SIGNAL_BARRIER: options.signalBarrier } : {}),
      ...(options.signalDelayMs ? { ALOOK_APP_TEST_TREE_SIGNAL_DELAY_MS: String(options.signalDelayMs) } : {}),
      ...(options.terminationBudgetMs
        ? { ALOOK_APP_TERMINATION_BUDGET_MS: String(options.terminationBudgetMs) }
        : {}),
      ...(options.watcherFailure ? { ALOOK_APP_TEST_WINDOWS_WATCHER_FAILURE: options.watcherFailure } : {}),
      ...(options.watcherFailureTrigger
        ? { ALOOK_APP_TEST_WINDOWS_WATCHER_FAILURE_TRIGGER: options.watcherFailureTrigger }
        : {}),
      ...options.supervisorEnv,
    },
  });
  const status = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    let settled = false;
    let stderr = Buffer.alloc(0);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const tail = stderr.toString().trim();
        reject(new Error(`${error.message}${tail ? `\nstderr tail:\n${tail}` : ""}`));
      } else resolvePromise(value!);
    };
    const timer = setTimeout(
      () => finish(new Error("supervisor acquisition timed out")),
      SUPERVISOR_ACQUISITION_BUDGET_MS + 2_000,
    );
    supervisor.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
    });
    supervisor.once("error", (error) => finish(error));
    supervisor.once("exit", (code, signal) => finish(new Error(
      `supervisor exited (${String(code ?? signal)}) before acquisition`,
    )));
    supervisor.once("disconnect", () => finish(new Error("supervisor IPC disconnected before acquisition")));
    supervisor.on("message", (message) => {
      const payload = message as { type?: string; status?: Record<string, unknown> };
      if (payload.type === "supervisor-error" || payload.type === "child-error" || payload.type === "child-exit") {
        finish(new Error(`${payload.type}: ${JSON.stringify(payload.status ?? {})}`));
        return;
      }
      if (payload.type !== "acquired") return;
      if (!payload.status) {
        finish(new Error("supervisor sent malformed acquired response"));
        return;
      }
      finish(undefined, payload.status);
    });
    supervisor.send({
      mode: "service",
      runId,
      service: "web",
      token,
      endpoint,
      command: process.execPath,
      args: [treeFixture, pidFile, mode],
      cwd: appRoot,
      env: process.env,
    });
  });
  await waitUntil(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { root: number; descendant: number };
  return {
    authority: { pid: status.supervisorPid as number, endpoint, token },
    pidFile,
    pids,
    runnerPid: status.childPid as number,
    runId,
    supervisor,
  };
}

async function launchUnownedTree() {
  const pidFile = join(scratch, `unowned-${Date.now()}.json`);
  const root = spawn(process.execPath, [treeFixture, pidFile, "stubborn"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await waitUntil(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { root: number; descendant: number };
  return { pids, root };
}

function forceKillTree(rootPid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(rootPid)], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-rootPid, "SIGKILL");
    }
  } catch {
    return;
  }
}

function windowsChildPids(parentPid: number): number[] {
  const script = [
    `$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | ForEach-Object { [int]$_.ProcessId })`,
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
  const output = execFileSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], { encoding: "utf8", windowsHide: true }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as number | number[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

beforeAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  execFileSync("bun", [
    "build",
    join(appRoot, "src/service-supervisor.ts"),
    "--outfile",
    supervisorEntry,
    "--target",
    "node",
    "--format",
    "esm",
  ], { cwd: appRoot, stdio: "pipe" });
  execFileSync("bun", [
    "build",
    join(appRoot, "test/fixtures/service-supervisor-windows-controlled.mjs"),
    "--outfile",
    controlledSupervisorEntry,
    "--target",
    "node",
    "--format",
    "esm",
  ], { cwd: appRoot, stdio: "pipe" });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("private supervisor authority", () => {
  it("handles partial, invalid, and timed-out authority responses deterministically", async () => {
    const partialEndpoint = testEndpoint("partial");
    const partial = createServer((socket) => {
      socket.once("data", () => {
        socket.write('{"ok":true,"runId":"run",');
        setTimeout(() => socket.end('"service":"web","supervisorPid":1,"childState":"running"}\n'), 5);
      });
    });
    await new Promise<void>((resolve) => partial.listen(partialEndpoint, resolve));
    await expect(requestAuthority({ pid: 1, endpoint: partialEndpoint, token: "token" }, "status", 100))
      .resolves.toMatchObject({ runId: "run", childState: "running" });
    await new Promise<void>((resolve) => partial.close(() => resolve()));

    const invalidEndpoint = testEndpoint("invalid");
    const invalid = createServer((socket) => socket.once("data", () => socket.end("not-json\n")));
    await new Promise<void>((resolve) => invalid.listen(invalidEndpoint, resolve));
    await expect(requestAuthority({ pid: 1, endpoint: invalidEndpoint, token: "token" }, "status", 100))
      .rejects.toThrow();
    await new Promise<void>((resolve) => invalid.close(() => resolve()));

    const silentEndpoint = testEndpoint("silent");
    let silentSocket: import("node:net").Socket | undefined;
    const silent = createServer((socket) => { silentSocket = socket; });
    await new Promise<void>((resolve) => silent.listen(silentEndpoint, resolve));
    await expect(requestAuthority({ pid: 1, endpoint: silentEndpoint, token: "token" }, "status", 20))
      .rejects.toThrow("authority status timed out");
    silentSocket?.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it.each(["graceful", "stubborn"] as const)(
    "terminates only the matching-token owned root and descendant tree (%s)",
    async (mode) => {
      const owned = await launchOwnedTree(mode);
      const wrong = { ...owned.authority, token: createAuthorityToken() };

      await expect(requestAuthority(wrong, "terminate", 1_000)).rejects.toThrow("authority token mismatch");
      expect(alive(owned.pids.root)).toBe(true);
      expect(alive(owned.pids.descendant)).toBe(true);

      const status = await requestAuthority(owned.authority, "status");
      expect(status).toMatchObject({
        runId: owned.runId,
        service: "web",
        supervisorPid: owned.authority.pid,
        childPid: owned.runnerPid,
        childState: "running",
      });

      await expect(requestAuthority(owned.authority, "terminate", 3_000)).resolves.toMatchObject({ childState: "stopped" });
      await waitUntil(() => !alive(owned.runnerPid) && !alive(owned.pids.root) && !alive(owned.pids.descendant));
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("keeps an authenticated terminate request alive beyond the generic socket timeout", async () => {
    const owned = await launchOwnedTree("stubborn", { terminationGraceMs: 2_100 });
    const startedAt = Date.now();

    await expect(requestAuthority(owned.authority, "terminate")).resolves.toMatchObject({ childState: "stopped" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    await waitUntil(() => !alive(owned.authority.pid) && !alive(owned.runnerPid));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("ignores every legacy ALOOK_APP_TEST hook in the bundled production entry", async () => {
    const barrier = join(scratch, `inert-test-env-${Date.now()}`);
    const trigger = `${barrier}.trigger`;
    writeFileSync(trigger, "trigger\n");
    const owned = await launchOwnedTree("graceful", {
      forceSignalError: true,
      reuseWindowsCommandRootPid: true,
      reusedSeedDescendantPid: 99_999,
      signalBarrier: barrier,
      signalDelayMs: 30_000,
      watcherFailure: "exit",
      watcherFailureTrigger: trigger,
    });
    try {
      await expect(requestAuthority(owned.authority, "terminate", 3_000))
        .resolves.toMatchObject({ childState: "stopped" });
      expect(existsSync(barrier)).toBe(false);
      await waitUntil(() => !alive(owned.runnerPid) && !alive(owned.pids.root) && !alive(owned.pids.descendant));
    } finally {
      forceKillTree(owned.runnerPid);
      if (alive(owned.authority.pid)) owned.supervisor.kill();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.skipIf(process.platform !== "win32")(
    "ignores PATH-shadowed PowerShell and taskkill in the bundled production entry",
    async () => {
      const attacker = join(scratch, `hostile path & ${Date.now()}`);
      mkdirSync(attacker, { recursive: true });
      writeFileSync(join(attacker, "powershell.exe"), "not an executable\n");
      writeFileSync(join(attacker, "taskkill.exe"), "not an executable\n");
      const owned = await launchOwnedTree("stubborn", { supervisorEnv: hostileWindowsPath(attacker) });
      try {
        await expect(requestAuthority(owned.authority, "terminate", 5_000))
          .resolves.toMatchObject({ childState: "stopped" });
        await waitUntil(() => !alive(owned.runnerPid) && !alive(owned.pids.root) && !alive(owned.pids.descendant));
      } finally {
        forceKillTree(owned.runnerPid);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("retains matching-token authority when the command root exits but its descendant survives", async () => {
    const owned = await launchOwnedTree("orphan");
    await waitUntil(async () => {
      const status = await requestAuthority(owned.authority, "status");
      return status.childState === "exited";
    });
    expect(alive(owned.pids.root)).toBe(false);
    expect(alive(owned.pids.descendant)).toBe(true);

    await expect(requestAuthority(owned.authority, "terminate", 3_000)).resolves.toMatchObject({ childState: "stopped" });
    await waitUntil(() => !alive(owned.runnerPid) && !alive(owned.pids.descendant));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.skipIf(process.platform !== "win32")(
    "retains a descendant created through a short-lived intermediate after seed acquisition",
    async () => {
      const owned = await launchOwnedTree("late-orphan");
      let latePids: { root: number; bridge: number; descendant: number } | undefined;
      try {
        writeFileSync(`${owned.pidFile}.spawn`, "spawn\n");
        await waitUntil(() => {
          const value = JSON.parse(readFileSync(owned.pidFile, "utf8")) as Partial<typeof latePids>;
          if (!value.bridge || !value.descendant) return false;
          latePids = value as typeof latePids;
          return true;
        });
        await waitUntil(() => !alive(latePids!.bridge));
        expect(alive(latePids!.descendant)).toBe(true);

        await expect(requestAuthority(owned.authority, "terminate", 5_000))
          .resolves.toMatchObject({ childState: "stopped" });
        await waitUntil(() => !alive(owned.runnerPid) && !alive(latePids!.descendant));
      } finally {
        if (latePids?.descendant && alive(latePids.descendant)) process.kill(latePids.descendant);
        forceKillTree(owned.pids.root);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed before signaling after the active Windows watcher is externally killed",
    async () => {
      const owned = await launchOwnedTree("stubborn", { terminationBudgetMs: 1_000 });
      try {
        const children = windowsChildPids(owned.authority.pid);
        const watcherPid = children.find((pid) => pid !== owned.runnerPid);
        expect(watcherPid).toBeDefined();
        execFileSync("taskkill", ["/F", "/PID", String(watcherPid)], { stdio: "ignore", windowsHide: true });
        await expect(requestAuthority(owned.authority, "terminate", 3_000))
          .rejects.toThrow("process watcher exited");
        await expect(requestAuthority(owned.authority, "status")).resolves.toMatchObject({
          runId: owned.runId,
          supervisorPid: owned.authority.pid,
        });
        expect(alive(owned.pids.root)).toBe(true);
        expect(alive(owned.pids.descendant)).toBe(true);
      } finally {
        forceKillTree(owned.runnerPid);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed when the controlled real WMI watcher withholds its marker",
    async () => {
      const trigger = join(scratch, `withhold-marker-${Date.now()}`);
      const owned = await launchOwnedTree("stubborn", {
        entry: controlledSupervisorEntry,
        terminationBudgetMs: 1_000,
        supervisorEnv: { ALOOK_FIXTURE_WITHHOLD_MARKER_TRIGGER: trigger },
      });
      try {
        writeFileSync(trigger, "withhold\n");
        await expect(requestAuthority(owned.authority, "terminate", 3_000)).rejects.toThrow("required marker");
        await expect(requestAuthority(owned.authority, "status")).resolves.toMatchObject({
          runId: owned.runId,
          supervisorPid: owned.authority.pid,
        });
        expect(alive(owned.pids.root)).toBe(true);
        expect(alive(owned.pids.descendant)).toBe(true);
      } finally {
        forceKillTree(owned.runnerPid);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a controlled reused Windows seed identity without adopting an unrelated tree",
    async () => {
      const control = join(scratch, `reused-seed-${Date.now()}.json`);
      const unrelated = await launchUnownedTree();
      const owned = await launchOwnedTree("graceful", {
        entry: controlledSupervisorEntry,
        supervisorEnv: { ALOOK_FIXTURE_REUSED_SEED_CONTROL: control },
      });
      try {
        writeFileSync(control, JSON.stringify({
          rootPid: owned.pids.root,
          unrelatedPid: unrelated.pids.root,
        }));
        await expect(requestAuthority(owned.authority, "terminate", 5_000))
          .rejects.toThrow("identity is unavailable");
        await expect(requestAuthority(owned.authority, "status")).resolves.toMatchObject({ runId: owned.runId });
        expect(alive(unrelated.pids.root)).toBe(true);
        expect(alive(unrelated.pids.descendant)).toBe(true);
      } finally {
        forceKillTree(owned.runnerPid);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
        forceKillTree(unrelated.pids.root);
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a controlled nonzero taskkill race while an owned descendant survives",
    async () => {
      const barrier = join(scratch, `taskkill-live-descendant-${Date.now()}`);
      const owned = await launchOwnedTree("orphan", {
        entry: controlledSupervisorEntry,
        supervisorEnv: {
          ALOOK_FIXTURE_FORCE_TREE_SIGNAL_ERROR: "1",
          ALOOK_FIXTURE_TREE_SIGNAL_BARRIER: barrier,
        },
      });
      try {
        await waitUntil(async () => (await requestAuthority(owned.authority, "status")).childState === "exited");
        expect(alive(owned.pids.descendant)).toBe(true);
        const termination = requestAuthority(owned.authority, "terminate", 5_000);
        await waitUntil(() => existsSync(barrier));
        process.kill(owned.runnerPid);
        await waitUntil(() => !alive(owned.runnerPid));
        writeFileSync(`${barrier}.release`, "continue\n");
        await expect(termination).rejects.toThrow("owned child tree");
        await expect(requestAuthority(owned.authority, "status", 2_000)).resolves.toMatchObject({ runId: owned.runId });
        expect(alive(owned.pids.descendant)).toBe(true);
      } finally {
        if (alive(owned.pids.descendant)) process.kill(owned.pids.descendant);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "win32")(
    "accepts a controlled nonzero taskkill race only after the independently tracked tree is empty",
    async () => {
      const barrier = join(scratch, `taskkill-empty-tree-${Date.now()}`);
      const owned = await launchOwnedTree("orphan", {
        entry: controlledSupervisorEntry,
        supervisorEnv: { ALOOK_FIXTURE_TREE_SIGNAL_BARRIER: barrier },
      });
      try {
        await waitUntil(async () => (await requestAuthority(owned.authority, "status")).childState === "exited");
        expect(alive(owned.pids.descendant)).toBe(true);
        const termination = requestAuthority(owned.authority, "terminate", 5_000);
        await waitUntil(() => existsSync(barrier));
        process.kill(owned.pids.descendant);
        process.kill(owned.runnerPid);
        await waitUntil(() => !alive(owned.pids.descendant) && !alive(owned.runnerPid));
        writeFileSync(`${barrier}.release`, "continue\n");
        await expect(termination).resolves.toMatchObject({ childState: "stopped" });
        await waitUntil(() => !alive(owned.authority.pid));
      } finally {
        if (alive(owned.pids.descendant)) process.kill(owned.pids.descendant);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("terminates cleanly after the launching CLI disconnects its readiness IPC", async () => {
    const owned = await launchOwnedTree("graceful");
    owned.supervisor.disconnect();
    owned.supervisor.unref();

    await expect(requestAuthority(owned.authority, "terminate", 3_000)).resolves.toMatchObject({ childState: "stopped" });
    await waitUntil(() => !alive(owned.runnerPid) && !alive(owned.pids.root) && !alive(owned.pids.descendant));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("derives an unguessable per-generation endpoint without exposing the token", () => {
    const token = createAuthorityToken();
    const endpoint = createControlEndpoint("run", "web", token);
    expect(token).toHaveLength(43);
    expect(endpoint).not.toContain(token);
    if (process.platform === "win32") expect(endpoint).toMatch(/^\\\\\.\\pipe\\alook-app-/);
    else expect(pathToFileURL(endpoint).pathname).toContain("/control/");
  });
});
