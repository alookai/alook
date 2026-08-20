import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { PassThrough } from "stream";
import { ProcessLane, type ProcessAdapterPrimitives } from "./process-host.js";
import type { AdapterLaunchContext, BackendConfig } from "../internal/adapter.js";
import { fakeLaunchContext } from "../testing/adapter-fixture.js";

const killProcessTree = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../internal/killTree.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../internal/killTree.js")>(),
  killProcessTree,
}));

/*
 * Red-line-5(b) of plans/daemon-trace-completeness-charter.md (T1): the synthetic
 * `session.fire("exit", {...})` tests in managerRuntime.test.ts prove the daemon
 * THREADS exitCode/exitSignal/abnormal into the FSM/trace. They do NOT prove the
 * SOURCE is real — that a genuinely killed subprocess actually fills `info.code`
 * / `info.signal` on the runtime session's `exit` event, which is what the
 * abnormal predicate (managerRuntime.ts) reads. A real subprocess dies here to
 * confirm that contract end-to-end (Node fills signal=SIGKILL, code=null; a
 * non-requested death → reason="runtime_exit"). Without this the "hardest to
 * reconstruct" blind spot would rest on an unverified assumption.
 */

const spawned: ChildProcess[] = [];

/** Minimal driver that spawns a real, long-lived child process. */
function realSpawnDriver(): ProcessAdapterPrimitives<string, BackendConfig> {
  return {
    id: "test-real",
    execution: {
      lifetime: "turn",
      transport: { kind: "one_shot_cli", protocol: "test.real.v1" },
      wakeStart: "immediate",
      terminalOwnership: "lane_generation",
    },
    currentSessionId: null,
    spawn: async () => {
      const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      spawned.push(proc);
      return { process: proc };
    },
    normalizeLine: () => [],
    encodeMessage: () => null,
  };
}

function minimalCtx(): AdapterLaunchContext {
  return fakeLaunchContext("claude", process.cwd(), {
    agentId: "a1",
  });
}

function controllableDriver(
  normalizeLine: ProcessAdapterPrimitives<string, BackendConfig>["normalizeLine"],
): {
  driver: ProcessAdapterPrimitives<string, BackendConfig>;
  stdout: PassThrough;
  process: ChildProcess;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const kill = vi.fn(() => true);
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill,
  }) as unknown as ChildProcess;
  const driver = {
    ...realSpawnDriver(),
    spawn: async () => ({ process: proc }),
    normalizeLine,
  };
  return { driver, stdout, process: proc, kill };
}

afterEach(() => {
  vi.useRealTimers();
  killProcessTree.mockClear();
  for (const p of spawned.splice(0)) {
    try { p.kill("SIGKILL"); } catch { /* already dead */ }
  }
});

describe("ProcessLane — real subprocess exit fills the physical fact (T1 red-line-5b)", () => {
  it("a real SIGKILLed subprocess emits exit with signal=SIGKILL, null code, reason=runtime_exit", async () => {
    // POSIX-only: Windows has no real signals — `process.kill(pid, "SIGKILL")`
    // terminates the child but Node reports `code=1, signal=null`, so the
    // `signal === "SIGKILL"` contract this asserts can't hold there. Skip on
    // win32 (same platform-guard as killTree.test.ts). The clean-exit sibling
    // below (code=0/signal=null) is cross-platform and still runs.
    if (process.platform === "win32") return;
    const session = new ProcessLane(realSpawnDriver(), minimalCtx());
    const exitInfo = await new Promise<{ code: number | null; signal: string | null; reason?: string }>(
      (resolve) => {
        session.on("exit", (...args: unknown[]) => resolve(args[0] as never));
        void session.start({ text: "go" }).then(() => {
          // Kill the real child directly (external kill, NOT session.stop()) so
          // requestedStopReason stays unset → reason="runtime_exit", the crash
          // shape the abnormal predicate must catch.
          const pid = session.pid;
          if (pid) process.kill(pid, "SIGKILL");
        });
      },
    );
    expect(exitInfo.signal).toBe("SIGKILL");
    expect(exitInfo.code).toBeNull();
    expect(exitInfo.reason).toBe("runtime_exit");
  });

  it("a real clean exit (code 0) emits code=0, null signal", async () => {
    const cleanDriver = {
      ...realSpawnDriver(),
      spawn: async () => {
        const proc = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] });
        spawned.push(proc);
        return { process: proc };
      },
    };
    const session = new ProcessLane(cleanDriver, minimalCtx());
    const exitInfo = await new Promise<{ code: number | null; signal: string | null; reason?: string }>(
      (resolve) => {
        session.on("exit", (...args: unknown[]) => resolve(args[0] as never));
        void session.start({ text: "go" });
      },
    );
    expect(exitInfo.code).toBe(0);
    expect(exitInfo.signal).toBeNull();
  });
});

describe("ProcessLane — raw stdout tap (P0-1)", () => {
  it("taps each complete non-empty line before normalizeLine and preserves the original text", async () => {
    const order: string[] = [];
    const normalizeLine = vi.fn((line: string) => {
      order.push(`parse:${line}`);
      return [];
    });
    const { driver, stdout } = controllableDriver(normalizeLine);
    const session = new ProcessLane(driver, minimalCtx(), {
      onRawStdoutLine: (line) => order.push(`raw:${line}`),
    });
    await session.start({ text: "go" });

    stdout.write(" {\"jsonrpc\":\"2.0\"}");
    stdout.write(" \n\npartial");

    expect(order).toEqual([
      'raw: {"jsonrpc":"2.0"} ',
      'parse: {"jsonrpc":"2.0"} ',
    ]);
    expect(normalizeLine).toHaveBeenCalledTimes(1);
  });

  it("continues through normalizeLine and runtime_event when the tap throws", async () => {
    const parsedEvent = { kind: "text", text: "ok" } as const;
    const normalizeLine = vi.fn(() => [parsedEvent]);
    const { driver, stdout } = controllableDriver(normalizeLine);
    const session = new ProcessLane(driver, minimalCtx(), {
      onRawStdoutLine: () => {
        throw new Error("sink failed");
      },
    });
    const events: unknown[] = [];
    session.on("runtime_event", (event) => events.push(event));
    await session.start({ text: "go" });

    expect(() => stdout.write('{"type":"message"}\n')).not.toThrow();
    expect(normalizeLine).toHaveBeenCalledWith('{"type":"message"}');
    expect(events).toEqual([parsedEvent]);
  });
});

describe("ProcessLane prompt admission ownership", () => {
  it("waits for a transport-owned turn receipt and returns that exact acknowledgement", async () => {
    const { driver, stdout } = controllableDriver((line) => [JSON.parse(line)]);
    Object.assign(driver, {
      execution: {
        lifetime: "session",
        transport: { kind: "stdio_rpc", protocol: "test.rpc.v1" },
        wakeStart: "immediate",
        terminalOwnership: "transport_request",
      },
    });
    const session = new ProcessLane(driver, minimalCtx());
    const observed: unknown[] = [];
    session.on("runtime_event", (event) => observed.push(event));
    let settled = false;
    const starting = session.start({ text: "go" }).then((admission) => {
      settled = true;
      return admission;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    stdout.write(`${JSON.stringify({ kind: "turn_owner", receipt: "owner-authoritative" })}\n`);
    await expect(starting).resolves.toEqual({
      ok: true,
      acceptedAs: "prompt",
      receipt: "owner-authoritative",
    });
    expect(observed).toEqual([{ kind: "turn_owner", receipt: "owner-authoritative" }]);
  });

  it.each(["missing", "destroyed", "ended"] as const)(
    "rejects start when persistent runtime stdin is %s",
    async (state) => {
      const { driver, process: proc } = controllableDriver(() => []);
      Object.assign(driver, {
        execution: {
          lifetime: "session",
          transport: { kind: "stdio_stream", protocol: "test.stream.v1" },
          wakeStart: "immediate",
          terminalOwnership: "vendor_message",
        },
      });
      if (state === "missing") Object.assign(proc, { stdin: null });
      else if (state === "destroyed") proc.stdin?.destroy();
      else proc.stdin?.end();

      const session = new ProcessLane(driver, minimalCtx());
      await expect(session.start({ text: "go", terminalOwner: "owner-prebound" })).resolves.toEqual({
        ok: false,
        reason: "stdin_unavailable",
        error: "runtime stdin is not writable",
      });
    },
  );

  it.each(["missing", "destroyed", "ended"] as const)(
    "rejects idle prompts and busy steers when persistent runtime stdin becomes %s",
    async (state) => {
      const { driver, process: proc } = controllableDriver(() => []);
      Object.assign(driver, {
        execution: {
          lifetime: "session",
          transport: { kind: "stdio_stream", protocol: "test.stream.v1" },
          wakeStart: "immediate",
          terminalOwnership: "vendor_message",
        },
      });
      const session = new ProcessLane(driver, minimalCtx());
      await expect(session.start({ text: "go", terminalOwner: "owner-start" })).resolves.toMatchObject({ ok: true });
      if (state === "missing") Object.assign(proc, { stdin: null });
      else if (state === "destroyed") proc.stdin?.destroy();
      else proc.stdin?.end();

      await expect(session.send({ text: "next", mode: "idle", terminalOwner: "owner-next" })).resolves.toEqual({
        ok: false,
        reason: "stdin_unavailable",
        error: "runtime stdin is not writable",
      });
      await expect(session.send({ text: "steer", mode: "busy", terminalOwner: "owner-start" })).resolves.toEqual({
        ok: false,
        reason: "stdin_unavailable",
        error: "runtime stdin is not writable",
      });
    },
  );

  it("times out a silent transport authority and stops the lane", async () => {
    vi.useFakeTimers();
    const { driver, kill } = controllableDriver(() => []);
    Object.assign(driver, {
      execution: {
        lifetime: "session",
        transport: { kind: "stdio_rpc", protocol: "test.rpc.v1" },
        wakeStart: "immediate",
        terminalOwnership: "transport_request",
      },
    });
    const session = new ProcessLane(driver, minimalCtx(), { promptAdmissionTimeoutMs: 25 });
    const starting = session.start({ text: "go" });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(25);
    await expect(starting).resolves.toEqual({
      ok: false,
      reason: "admission_timeout",
      error: "runtime did not acknowledge command admission before the deadline",
    });
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("ProcessLane interrupt", () => {
  it("sends SIGINT only while the process is open", async () => {
    const { driver, process: proc, kill } = controllableDriver(() => []);
    const session = new ProcessLane(driver, minimalCtx());
    await expect(session.interrupt()).resolves.toBe(false);
    await session.start({ text: "go" });
    expect(session.signalCode).toBeNull();
    await expect(session.interrupt()).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGINT");
    Object.assign(proc, { exitCode: 0 });
    await expect(session.interrupt()).resolves.toBe(false);
  });
});

describe("ProcessLane stop", () => {
  it("idempotently kills the detached process group when its root handle is already terminal", async () => {
    const { driver, process: proc, kill } = controllableDriver(() => []);
    Object.defineProperty(proc, "pid", { value: 41_002, configurable: true });
    const session = new ProcessLane(driver, minimalCtx());
    await session.start({ text: "go" });
    Object.assign(proc, { exitCode: 0 });

    await Promise.all([
      session.stop({ reason: "shutdown", forceAfterMs: 0 }),
      session.stop({ reason: "shutdown", forceAfterMs: 0 }),
    ]);

    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(killProcessTree).toHaveBeenCalledWith(41_002, { graceMs: 0 });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not fall back to direct handle kill for a terminal root without a pid", async () => {
    const { driver, process: proc, kill } = controllableDriver(() => []);
    const session = new ProcessLane(driver, minimalCtx());
    await session.start({ text: "go" });
    Object.assign(proc, { exitCode: 0 });

    await session.stop({ reason: "runtime_exit", forceAfterMs: 0 });

    expect(killProcessTree).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
