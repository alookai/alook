import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAuthorityToken,
  createControlEndpoint,
  requestAuthority,
  SUPERVISOR_ACQUISITION_BUDGET_MS,
} from "../src/lib/control-authority.js";

const scratch = join(tmpdir(), `alook-control-authority-${process.pid}`);
const supervisorEntry = join(scratch, "service-supervisor.js");
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const treeFixture = join(appRoot, "test/fixtures/process-tree-child.mjs");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    terminationBudgetMs?: number;
    watcherFailure?: "exit" | "withhold-watermark";
    watcherFailureTrigger?: string;
  } = {},
) {
  const token = createAuthorityToken();
  const runId = `run-${mode}-${Date.now()}`;
  const endpoint = createControlEndpoint(runId, "web", token);
  const pidFile = join(scratch, `${runId}.json`);
  const supervisor = fork(supervisorEntry, [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      ALOOK_APP_TERMINATION_GRACE_MS: "100",
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
    },
  });
  const status = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error("supervisor acquisition timed out")),
      SUPERVISOR_ACQUISITION_BUDGET_MS + 2_000,
    );
    supervisor.once("error", reject);
    supervisor.on("message", (message) => {
      const payload = message as { type?: string; status?: Record<string, unknown> };
      if (payload.type !== "acquired" || !payload.status) return;
      clearTimeout(timer);
      resolvePromise(payload.status);
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
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("private supervisor authority", () => {
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
    15_000,
  );

  it("keeps an authenticated terminate request alive beyond the generic socket timeout", async () => {
    const owned = await launchOwnedTree("graceful", { signalDelayMs: 2_100 });
    const startedAt = Date.now();

    await expect(requestAuthority(owned.authority, "terminate")).resolves.toMatchObject({ childState: "stopped" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    await waitUntil(() => !alive(owned.authority.pid) && !alive(owned.runnerPid));
  }, 15_000);

  it("returns a slow termination failure without dropping its authority endpoint", async () => {
    const owned = await launchOwnedTree("stubborn", { forceSignalError: true, signalDelayMs: 2_100 });
    const startedAt = Date.now();
    try {
      await expect(requestAuthority(owned.authority, "terminate")).rejects.toThrow("owned child tree");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
      await expect(requestAuthority(owned.authority, "status")).resolves.toMatchObject({
        runId: owned.runId,
        supervisorPid: owned.authority.pid,
      });
    } finally {
      forceKillTree(owned.runnerPid);
      if (alive(owned.authority.pid)) owned.supervisor.kill();
    }
  }, 15_000);

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
  }, 15_000);

  it.skipIf(process.platform !== "win32")(
    "retains a descendant created through a short-lived intermediate after seed acquisition",
    async () => {
      const barrier = join(scratch, `late-orphan-${Date.now()}`);
      const owned = await launchOwnedTree("late-orphan", { forceSignalError: true, signalBarrier: barrier });
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

        const termination = requestAuthority(owned.authority, "terminate", 5_000);
        await waitUntil(() => existsSync(barrier));
        process.kill(owned.pids.root);
        process.kill(owned.runnerPid);
        await waitUntil(() => !alive(owned.pids.root) && !alive(owned.runnerPid));
        expect(alive(latePids!.descendant)).toBe(true);
        writeFileSync(`${barrier}.release`, "continue\n");

        await expect(termination).rejects.toThrow("owned child tree");
        await expect(requestAuthority(owned.authority, "status")).resolves.toMatchObject({
          runId: owned.runId,
          supervisorPid: owned.authority.pid,
        });
        expect(alive(latePids!.descendant)).toBe(true);
      } finally {
        if (latePids?.descendant && alive(latePids.descendant)) process.kill(latePids.descendant);
        forceKillTree(owned.pids.root);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32").each(["exit", "withhold-watermark"] as const)(
    "fails closed before signaling when the Windows process watcher authority becomes incomplete (%s)",
    async (watcherFailure) => {
      const barrier = join(scratch, `watcher-${watcherFailure}-${Date.now()}`);
      const failureTrigger = `${barrier}.fail`;
      const owned = await launchOwnedTree("stubborn", {
        signalBarrier: barrier,
        terminationBudgetMs: 1_000,
        watcherFailure,
        watcherFailureTrigger: failureTrigger,
      });
      try {
        writeFileSync(failureTrigger, "fail\n");
        await expect(requestAuthority(owned.authority, "terminate", 3_000)).rejects.toThrow(
          watcherFailure === "exit" ? "process watcher exited" : "required watermark",
        );
        expect(existsSync(barrier)).toBe(false);
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
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a reused Windows seed identity without adopting or killing an unrelated tree",
    async () => {
      const unrelated = await launchUnownedTree();
      const owned = await launchOwnedTree("graceful", {
        reuseWindowsCommandRootPid: true,
        reusedSeedDescendantPid: unrelated.pids.root,
      });
      try {
        await expect(requestAuthority(owned.authority, "terminate")).rejects.toThrow("identity is unavailable");
        await expect(requestAuthority(owned.authority, "status")).resolves.toMatchObject({
          runId: owned.runId,
          supervisorPid: owned.authority.pid,
        });
        expect(alive(unrelated.pids.root)).toBe(true);
        expect(alive(unrelated.pids.descendant)).toBe(true);
      } finally {
        forceKillTree(owned.runnerPid);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
        forceKillTree(unrelated.pids.root);
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a nonzero taskkill race when the runner exits but an owned descendant survives",
    async () => {
      const barrier = join(scratch, `taskkill-live-descendant-${Date.now()}`);
      const owned = await launchOwnedTree("orphan", { forceSignalError: true, signalBarrier: barrier });
      try {
        await waitUntil(async () => (await requestAuthority(owned.authority, "status")).childState === "exited");
        expect(alive(owned.pids.descendant)).toBe(true);

        const termination = requestAuthority(owned.authority, "terminate", 5_000);
        await waitUntil(() => existsSync(barrier));
        process.kill(owned.runnerPid);
        await waitUntil(() => !alive(owned.runnerPid));
        writeFileSync(`${barrier}.release`, "continue\n");

        await expect(termination).rejects.toThrow("owned child tree");
        await expect(requestAuthority(owned.authority, "status", 2_000)).resolves.toMatchObject({
          runId: owned.runId,
          supervisorPid: owned.authority.pid,
        });
        expect(alive(owned.pids.descendant)).toBe(true);
      } finally {
        if (alive(owned.pids.descendant)) process.kill(owned.pids.descendant);
        if (alive(owned.authority.pid)) owned.supervisor.kill();
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "accepts a nonzero taskkill race only after the independently tracked tree is empty",
    async () => {
      const barrier = join(scratch, `taskkill-empty-tree-${Date.now()}`);
      const owned = await launchOwnedTree("orphan", { signalBarrier: barrier });
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
    15_000,
  );

  it("terminates cleanly after the launching CLI disconnects its readiness IPC", async () => {
    const owned = await launchOwnedTree("graceful");
    owned.supervisor.disconnect();
    owned.supervisor.unref();

    await expect(requestAuthority(owned.authority, "terminate", 3_000)).resolves.toMatchObject({ childState: "stopped" });
    await waitUntil(() => !alive(owned.runnerPid) && !alive(owned.pids.root) && !alive(owned.pids.descendant));
  }, 15_000);

  it("derives an unguessable per-generation endpoint without exposing the token", () => {
    const token = createAuthorityToken();
    const endpoint = createControlEndpoint("run", "web", token);
    expect(token).toHaveLength(43);
    expect(endpoint).not.toContain(token);
    if (process.platform === "win32") expect(endpoint).toMatch(/^\\\\\.\\pipe\\alook-app-/);
    else expect(pathToFileURL(endpoint).pathname).toContain("/control/");
  });
});
