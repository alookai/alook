import { describe, it, expect } from "vitest";
import { MockServer } from "./mockServer";
import type { HostCommand } from "./contract";

/**
 * At-least-once control-plane delivery: the server tags each dispatch with a
 * deliveryId, keeps it "unacked" until the host acks, and redelivers the SAME id
 * on reconnect. These tests drive the real MockServer command sink directly.
 */
async function setup() {
  const s = new MockServer();
  const { user } = await s.createUser({ name: "u" });
  const { agent } = await s.createAgent({ userId: user.id, name: "cindy", runtime: "mock" });
  const { server } = await s.createServer({ name: "demo" });
  await s.addAgentToServer({ agentId: agent.id, server: server.id });
  const { channel } = await s.createChannel({ server: server.id, name: "general" });
  const ref = `/${server.id}/${channel.id}`;
  return { s, agentId: agent.id, ref };
}

describe("control-plane at-least-once delivery", () => {
  it("tags a dispatch with a deliveryId and retains it until acked", async () => {
    const { s, ref } = await setup();
    const cmds: HostCommand[] = [];
    s.attachHost((c) => cmds.push(c));

    s.post({ channel: ref, sender: "@gustavo", text: "hi" });
    expect(cmds.length).toBe(1);
    const cmd = cmds[0];
    // The recipient isn't running yet → it's an agent:start carrying the wake.
    expect(cmd.type).toBe("agent:start");
    const deliveryId = (cmd as Extract<HostCommand, { type: "agent:start" }>).deliveryId!;
    expect(deliveryId).toMatch(/^dlv_/);

    // Before ack: a reconnect redelivers the same id.
    const redelivered: HostCommand[] = [];
    s.attachHost((c) => redelivered.push(c));
    s.redeliverUnacked();
    expect(redelivered.length).toBe(1);
    expect((redelivered[0] as any).deliveryId).toBe(deliveryId);

    // After ack: nothing is redelivered.
    s.ackDelivery(deliveryId);
    const after: HostCommand[] = [];
    s.attachHost((c) => after.push(c));
    s.redeliverUnacked();
    expect(after.length).toBe(0);
  });

  it("resetRunningAgents replaces (not merges) the running set", async () => {
    const { s, agentId, ref } = await setup();
    const cmds: HostCommand[] = [];
    s.attachHost((c) => cmds.push(c));

    // Host says a1 is running → a post delivers (not starts).
    s.resetRunningAgents([agentId]);
    s.post({ channel: ref, sender: "@gustavo", text: "one" });
    expect(cmds.at(-1)!.type).toBe("agent:deliver");

    // Host reconnects reporting NO running agents → next post must start again.
    s.resetRunningAgents([]);
    s.post({ channel: ref, sender: "@gustavo", text: "two" });
    expect(cmds.at(-1)!.type).toBe("agent:start");
  });
});
