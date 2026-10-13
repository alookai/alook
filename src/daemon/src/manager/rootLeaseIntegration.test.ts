import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { AgentMessage, BuiltinBackendSpecs, PreparedExecutionResource } from "@alook/agent-driver";
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
  it("keeps a native failed command queued through old terminal and cleanup, then replays its original input", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T07:00:00Z"));
    let now = 0;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const release = vi.fn(() => closeGate);
    const host = createFakeAgentDriverHost();
    const children = [fakeProcess(), fakeProcess()];
    const sessions = children.map((childProcess, index) => {
      const adapter = new CodexDriver();
      vi.spyOn(adapter, "spawn").mockResolvedValue({ process: childProcess });
      const prepared: PreparedExecutionResource = {
        environmentLayers: {
          base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {},
          runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
        },
        release: index === 0 ? release : async () => {},
      };
      return new LogicalAgentSession<BuiltinBackendSpecs, "codex">(
        "codex", { model: { kind: "default" }, mode: "default" },
        { workingDirectory: process.cwd(), instructions: "", launchId: `delivery-${index}` },
        adapter, createBuiltinAgentDriverRegistry().get("codex").capabilities, host, prepared, 1_000,
      );
    });
    const firstSend = vi.spyOn(sessions[0]!, "send");
    const nextStart = vi.spyOn(sessions[1]!, "start");
    const nextSend = vi.spyOn(sessions[1]!, "send");
    const trace: Array<{ event?: string; status?: string; effects?: string[] }> = [];
    let nextSession = 0;
    const manager = new AgentProcessManager({
      driverFor: () => ({ id: "codex" }),
      baseContextFor: () => ({
        workingDirectory: process.cwd(), agentId: "a1", standingPrompt: "",
        config: {} as HostLaunchContext["config"], credentialProxy: {} as HostLaunchContext["credentialProxy"],
      }),
      sessionFactory: () => sessions[nextSession++]!,
      now: () => now,
      tickIntervalMs: 5,
      stampWakePromptTime: true,
      wakePromptFooter: "native delivery footer",
      onFsmTransition: (row) => trace.push(row),
    });
    const raw = async (index: number, value: unknown) => {
      children[index]!.stdout.write(`${JSON.stringify(value)}\n`);
      await flushEvents();
    };
    try {
      manager.register("a1");
      manager.start();
      manager.deliver("a1", { id: "root-command", seq: 1, text: "root" });
      await flushEvents();
      await raw(0, { jsonrpc: "2.0", id: 2, result: { thread: { id: "root-thread" } } });
      await raw(0, { jsonrpc: "2.0", method: "turn/started", params: {
        threadId: "root-thread", turn: { id: "root-vendor-turn", status: "inProgress" },
      } });
      await raw(0, { jsonrpc: "2.0", method: "item/started", params: {
        threadId: "root-thread", turnId: "root-vendor-turn", item: { id: "compaction", type: "contextCompaction" },
      } });
      manager.deliver("a1", { id: "retry-command", seq: 2, text: "retry" });
      await flushEvents();
      expect(firstSend).toHaveBeenCalledOnce();
      const original: AgentMessage = firstSend.mock.calls[0]![0];
      expect(original).toEqual({ id: "retry-command", kind: "user", text: expect.stringMatching(/^\[[^\]]+\] retry\n\nnative delivery footer$/), sequence: 2 });
      expect(manager.snapshot().agents.a1.pendingAdmissions.map((entry) => entry.commandId)).toEqual(["retry-command"]);
      expect(sessions[0]!.snapshot().queuedCommands.map((command) => command.commandId)).toEqual(["retry-command"]);

      now = 400_000;
      vi.setSystemTime(new Date("2026-10-13T07:01:00Z"));
      await vi.waitFor(() => {
        expect(manager.snapshot().agents.a1).toMatchObject({ status: "stopping", inbox: [
          { id: "retry-command", seq: 2, text: "retry", preparedInput: original },
        ] });
        expect(release).toHaveBeenCalledOnce();
      });
      expect(sessions[0]!.snapshot().state).toBe("stopping");
      expect(firstSend).toHaveBeenCalledOnce();
      expect(nextStart).not.toHaveBeenCalled();
      expect(trace.some((row) => row.event === "turn_end" && row.status === "stopping" && !row.effects?.includes("send"))).toBe(true);

      releaseClose();
      await sessions[0]!.closed;
      await flushEvents();
      expect(nextStart).toHaveBeenCalledExactlyOnceWith(original);
      expect(nextSend).not.toHaveBeenCalled();
      await raw(1, { jsonrpc: "2.0", id: 2, result: { thread: { id: "replacement-thread" } } });
      await raw(1, { jsonrpc: "2.0", method: "turn/started", params: {
        threadId: "replacement-thread", turn: { id: "replacement-vendor-turn", status: "inProgress" },
      } });
      expect(manager.snapshot().agents.a1).toMatchObject({ status: "running", inbox: [], execution: {
        sessionInstanceId: sessions[1]!.sessionInstanceId,
      } });
      await expect(sessions[1]!.send({ ...original, text: "changed retry" })).resolves.toEqual({ status: "rejected", reason: "duplicate_conflict" });
    } finally {
      releaseClose();
      await manager.stopAll();
      vi.useRealTimers();
    }
  });

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
