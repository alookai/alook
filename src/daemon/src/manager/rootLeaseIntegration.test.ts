import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { BuiltinBackendSpecs, PreparedExecutionResource } from "@alook/agent-driver";
import type { AdapterEvent, BackendAdapter } from "@alook/agent-driver/adapter-author";
import { createBuiltinAgentDriverRegistry } from "@alook/agent-driver/adapter-author";
import { createFakeAgentDriverHost } from "@alook/agent-driver/testing";
import { LogicalAgentSession } from "../../agent-driver/src/controller/logical-session.js";
import { AgentProcessManager } from "./managerRuntime.js";
import type { HostLaunchContext } from "./hostContext.js";

interface RawEnvelope {
  owner: "root" | "child" | "stale";
  event: AdapterEvent;
}

class RootOwnedRawAdapter implements BackendAdapter<"claude"> {
  readonly id = "claude";
  readonly instructionDelivery = { kind: "native" } as const;
  readonly execution = { kind: "persistent_process", input: "safe_boundary" } as const;
  readonly currentSessionId = null;
  readonly process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };

  probe() { return { status: "healthy" as const }; }
  async spawn() { return { process: this.process }; }
  normalizeLine(line: string): AdapterEvent[] {
    const envelope = JSON.parse(line) as RawEnvelope;
    return envelope.owner === "root" ? [envelope.event] : [];
  }
  encodeMessage(text: string) { return text; }
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe("raw adapter → public session → manager root lease", () => {
  it("contains a false terminal, ignores unowned work/duplicates, and permits a proven re-close", async () => {
    let now = 0;
    const adapter = new RootOwnedRawAdapter();
    const host = createFakeAgentDriverHost();
    const prepared: PreparedExecutionResource = {
      environmentLayers: {
        base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {},
        runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
      },
      async release() {},
    };
    const session = new LogicalAgentSession<BuiltinBackendSpecs, "claude">(
      "claude",
      { model: { kind: "default" }, provider: { kind: "default" }, mode: "default" },
      { workingDirectory: process.cwd(), instructions: "", launchId: "integration" },
      adapter,
      createBuiltinAgentDriverRegistry().get("claude").capabilities,
      host,
      prepared,
      100,
    );
    const trace: Array<{ event?: string; recordKind?: string }> = [];
    const manager = new AgentProcessManager({
      driverFor: () => ({ id: "claude" }),
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
    const raw = async (owner: RawEnvelope["owner"], event: AdapterEvent) => {
      adapter.process.stdout.write(`${JSON.stringify({ owner, event } satisfies RawEnvelope)}\n`);
      await flushEvents();
    };

    manager.register("a1");
    manager.deliver("a1", { id: "command-one", text: "work" });
    await flushEvents();
    const turnId = session.snapshot().activeTurn?.turnId;
    expect(turnId).toBeTruthy();
    expect(manager.snapshot().agents.a1.execution.lease).toMatchObject({ state: "active", identity: { turnId } });

    now = 10;
    await raw("root", { kind: "turn_end", sessionId: "root-session" });
    expect(manager.snapshot().agents.a1).toMatchObject({ idleSince: 10, turnActive: false });

    now = 20;
    await raw("root", { kind: "turn_end", sessionId: "root-session" });
    await raw("child", { kind: "internal_progress", source: "child", itemType: "unowned" });
    await raw("stale", { kind: "internal_progress", source: "stale", itemType: "unowned" });
    expect(manager.snapshot().agents.a1).toMatchObject({ idleSince: 10, turnActive: false });

    now = 30;
    await raw("root", { kind: "internal_progress", source: "root", itemType: "proven-work" });
    expect(manager.snapshot().agents.a1.execution.lease).toMatchObject({
      state: "suspect_active",
      identity: { sessionInstanceId: session.sessionInstanceId, turnId },
      reason: "work_after_terminal",
    });
    expect(manager.snapshot().agents.a1.idleSince).toBeNull();

    now = 40;
    await raw("root", { kind: "turn_end", sessionId: "root-session" });
    await raw("root", { kind: "turn_end", sessionId: "root-session" });
    expect(manager.snapshot().agents.a1.execution.lease).toMatchObject({
      state: "none",
      lastTerminal: { identity: { turnId }, at: 40 },
    });
    expect(trace.filter((row) => row.event === "turn_end" && row.recordKind === "fsm"))
      .toHaveLength(2);

    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });
});
