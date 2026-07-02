import { describe, it, expect } from "vitest";
import { AgentRouter } from "./agentRouter";
import type { AgentProcessManager } from "./managerRuntime";
import type { HostControlChannel, HostCommand, Message } from "../server/contract";

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
    onResync() {},
  };
  return { ch, acks, readys, fire: (c: HostCommand) => handler?.(c) };
}

describe("AgentRouter — at-least-once dedup", () => {
  it("acks every delivery, but only wakes the manager once per deliveryId", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, acks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimes: ["mock"] });
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
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimes: ["mock"] });
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

describe("AgentRouter — buildReady runtimeReport", () => {
  it("emits runtimeReport when provided", async () => {
    const { mgr } = fakeManager();
    const { ch, readys } = fakeChannel();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimes: ["claude", "codex"],
      runtimeReport: [
        { id: "claude", version: "1.0.42" },
        { id: "codex", version: "0.8.1" },
      ],
    });
    await router.start();
    expect(readys[0]).toMatchObject({
      runtimes: ["claude", "codex"],
      runtimeReport: [
        { id: "claude", version: "1.0.42" },
        { id: "codex", version: "0.8.1" },
      ],
    });
  });

  it("omits runtimeReport when not provided", async () => {
    const { mgr } = fakeManager();
    const { ch, readys } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimes: ["claude"] });
    await router.start();
    expect(readys[0]).toMatchObject({ runtimes: ["claude"] });
    expect("runtimeReport" in readys[0]).toBe(false);
  });
});
