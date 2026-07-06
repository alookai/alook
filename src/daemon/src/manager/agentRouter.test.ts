import { describe, it, expect } from "vitest";
import { AgentRouter, UnknownRuntimeError } from "./agentRouter";
import type { AgentProcessManager } from "./managerRuntime";
import type { HostControlChannel, HostCommand, Message, SessionErrorFrame } from "../server/contract";

function msg(seq: string, text: string): Message {
  return { seq, channel: "/demo/general", sender: "@gustavo", content: { text }, time: "t" };
}

/** Fake manager recording deliver/register; enough for router behavior tests. */
function fakeManager() {
  const delivers: Array<{ agentId: string; text: string }> = [];
  const mgr = {
    register() {},
    deliver(agentId: string, m: { seq: number; text: string }) {
      delivers.push({ agentId, text: m.text });
    },
    stop() {},
    liveSessionReports: () => [],
  } as unknown as AgentProcessManager;
  return { mgr, delivers };
}

/** Fake channel capturing acks + the command handler the router registers. */
function fakeChannel() {
  let handler: ((c: HostCommand) => void | Promise<void>) | null = null;
  const acks: string[] = [];
  const readys: Array<Parameters<HostControlChannel["reportReady"]>[0]> = [];
  const sessionErrors: SessionErrorFrame[] = [];
  const ch: HostControlChannel = {
    onCommand(cb) {
      handler = cb;
    },
    async reportReady(ready) {
      readys.push(ready);
    },
    async reportAgentSession() {},
    async reportDeliverAck(info) {
      acks.push(info.deliveryId);
    },
    async reportSessionError(frame) {
      sessionErrors.push(frame);
    },
    onResync() {},
  };
  return { ch, acks, readys, sessionErrors, fire: (c: HostCommand) => handler?.(c) };
}

describe("AgentRouter — at-least-once dedup", () => {
  it("acks every delivery, but only wakes the manager once per deliveryId", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, acks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    const deliver: HostCommand = { type: "agent:deliver", agentId: "a1", message: msg("#1", "hello"), deliveryId: "dlv_1" };
    await fire(deliver);
    await fire(deliver); // redelivery of the SAME id (e.g. after a reconnect)

    // Manager woken exactly once; both deliveries acked (so the server retires it).
    expect(delivers.length).toBe(1);
    expect(delivers[0]).toEqual({ agentId: "a1", text: "hello" });
    expect(acks).toEqual(["dlv_1", "dlv_1"]);
  });

  it("agent:start wake delivers + acks its deliveryId", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, acks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    await fire({
      type: "agent:start",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      wakeMessage: msg("#1", "wake"),
      deliveryId: "dlv_w",
      launchId: "l1",
    });
    expect(delivers).toEqual([{ agentId: "a1", text: "wake" }]);
    expect(acks).toEqual(["dlv_w"]);
  });
});

describe("AgentRouter — unknown runtime → session.error", () => {
  it("catches UnknownRuntimeError from driverFor and forwards session.error{runtime_not_available}", async () => {
    // Manager whose register() re-throws whatever driverFor throws — mimics
    // the real AgentProcessManager which calls opts.driverFor eagerly.
    const throwing: UnknownRuntimeError = new UnknownRuntimeError("gemini", ["claude", "codex"]);
    const mgr = {
      register() {
        throw throwing;
      },
      deliver() {},
      stop() {},
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, sessionErrors, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "claude" }, { id: "codex" }] });
    await router.start();

    await fire({
      type: "agent:start",
      agentId: "a1",
      config: { version: 1, runtime: "gemini", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
    });

    expect(sessionErrors.length).toBe(1);
    expect(sessionErrors[0]).toMatchObject({
      type: "session.error",
      code: "runtime_not_available",
      agentId: "a1",
      payload: { requested: "gemini", available: ["claude", "codex"] },
    });
  });
});

describe("AgentRouter — buildReady runtimeReport", () => {
  it("emits runtimeReport when provided", async () => {
    const { mgr } = fakeManager();
    const { ch, readys } = fakeChannel();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [
        { id: "claude", version: "1.0.42" },
        { id: "codex", version: "0.8.1" },
      ],
    });
    await router.start();
    expect(readys[0]).toMatchObject({
      runtimeReport: [
        { id: "claude", version: "1.0.42" },
        { id: "codex", version: "0.8.1" },
      ],
    });
  });

  it("passes runtimeReport through with only bare ids", async () => {
    const { mgr } = fakeManager();
    const { ch, readys } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "claude" }] });
    await router.start();
    expect(readys[0]).toMatchObject({ runtimeReport: [{ id: "claude" }] });
  });
});
