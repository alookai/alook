import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { ChildProcessRuntimeSession } from "./runtimeSession.js";
import type { Driver, LaunchContext } from "../types.js";

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
function realSpawnDriver(): Driver {
  return {
    id: "test-real",
    lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" },
    spawn: async () => {
      const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      spawned.push(proc);
      return { process: proc };
    },
    parseLine: () => [],
    encodeStdinMessage: () => null,
    buildSystemPrompt: () => "",
  } as unknown as Driver;
}

function minimalCtx(): LaunchContext {
  return {
    workingDirectory: process.cwd(),
    agentId: "a1",
    standingPrompt: "",
    prompt: "",
    config: {} as LaunchContext["config"],
    credentialProxy: {} as LaunchContext["credentialProxy"],
  } as LaunchContext;
}

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try { p.kill("SIGKILL"); } catch { /* already dead */ }
  }
});

describe("ChildProcessRuntimeSession — real subprocess exit fills the physical fact (T1 red-line-5b)", () => {
  it("a real SIGKILLed subprocess emits exit with signal=SIGKILL, null code, reason=runtime_exit", async () => {
    // POSIX-only: Windows has no real signals — `process.kill(pid, "SIGKILL")`
    // terminates the child but Node reports `code=1, signal=null`, so the
    // `signal === "SIGKILL"` contract this asserts can't hold there. Skip on
    // win32 (same platform-guard as killTree.test.ts). The clean-exit sibling
    // below (code=0/signal=null) is cross-platform and still runs.
    if (process.platform === "win32") return;
    const session = new ChildProcessRuntimeSession(realSpawnDriver(), minimalCtx());
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
    } as unknown as Driver;
    const session = new ChildProcessRuntimeSession(cleanDriver, minimalCtx());
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
