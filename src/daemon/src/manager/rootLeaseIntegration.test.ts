import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { BuiltinBackendSpecs, PreparedExecutionResource } from "@alook/agent-driver";
import { createBuiltinAgentDriverRegistry } from "@alook/agent-driver/adapter-author";
import { createFakeAgentDriverHost } from "@alook/agent-driver/testing";
import { CodexDriver } from "../../agent-driver/src/adapters/codex/index.js";
import { LogicalAgentSession } from "../../agent-driver/src/controller/logical-session.js";
import { AgentProcessManager } from "./managerRuntime.js";
import type { HostLaunchContext } from "./hostContext.js";

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe("raw adapter → public session → manager root lease", () => {
  it("contains a false terminal, ignores unowned work/duplicates, and permits a proven re-close", async () => {
    let now = 0;
    const adapter = new CodexDriver();
    const childProcess = fakeProcess();
    vi.spyOn(adapter, "spawn").mockResolvedValue({ process: childProcess });
    const host = createFakeAgentDriverHost();
    const prepared: PreparedExecutionResource = {
      environmentLayers: {
        base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {},
        runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
      },
      async release() {},
    };
    const session = new LogicalAgentSession<BuiltinBackendSpecs, "codex">(
      "codex",
      { model: { kind: "default" }, mode: "default" },
      { workingDirectory: process.cwd(), instructions: "", launchId: "integration" },
      adapter,
      createBuiltinAgentDriverRegistry().get("codex").capabilities,
      host,
      prepared,
      100,
    );
    const trace: Array<{ event?: string; recordKind?: string }> = [];
    const manager = new AgentProcessManager({
      driverFor: () => ({ id: "codex" }),
      baseContextFor: () => ({
        workingDirectory: process.cwd(),
        agentId: "a1",
        standingPrompt: "",
        config: {} as HostLaunchContext["config"],
        credentialProxy: {} as HostLaunchContext["credentialProxy"],
      }),
      sessionFactory: () => session,
      now: () => now,
      onFsmTransition: (row) => trace.push(row),
    });
    const raw = async (method: string, params: unknown) => {
      childProcess.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      await flushEvents();
    };

    manager.register("a1");
    manager.deliver("a1", { id: "command-one", text: "work" });
    await flushEvents();
    childProcess.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "root-thread" } } })}\n`);
    await raw("turn/started", {
      threadId: "root-thread",
      turn: { id: "root-vendor-turn", status: "inProgress" },
    });
    const turnId = session.snapshot().activeTurn?.turnId;
    expect(turnId).toBeTruthy();
    expect(manager.snapshot().agents.a1.execution.lease).toMatchObject({ state: "active", identity: { turnId } });

    now = 10;
    await raw("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-vendor-turn", status: "completed" },
    });
    expect(manager.snapshot().agents.a1).toMatchObject({ idleSince: 10, turnActive: false });

    now = 20;
    await raw("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-vendor-turn", status: "completed" },
    });
    await raw("rawResponseItem/completed", { threadId: "child-thread", turnId: "root-vendor-turn" });
    await raw("rawResponseItem/completed", { threadId: "root-thread", turnId: "stale-turn" });
    expect(manager.snapshot().agents.a1).toMatchObject({ idleSince: 10, turnActive: false });

    now = 30;
    await raw("rawResponseItem/completed", { threadId: "root-thread", turnId: "root-vendor-turn" });
    expect(manager.snapshot().agents.a1.execution.lease).toMatchObject({
      state: "suspect_active",
      identity: { sessionInstanceId: session.sessionInstanceId, turnId },
      reason: "work_after_terminal",
    });
    expect(manager.snapshot().agents.a1.idleSince).toBeNull();

    now = 40;
    await raw("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-vendor-turn", status: "completed" },
    });
    await raw("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-vendor-turn", status: "completed" },
    });
    expect(manager.snapshot().agents.a1.execution.lease).toMatchObject({
      state: "none",
      lastTerminal: { identity: { turnId }, at: 40 },
    });
    expect(trace.filter((row) => row.event === "turn_end" && row.recordKind === "fsm"))
      .toHaveLength(2);

    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });
});
