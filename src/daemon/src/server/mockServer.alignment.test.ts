import { describe, it, expect } from "vitest";
import { MockServer } from "./mockServer";

/**
 * Channel alignment is enforced SERVER-SIDE: send() falls back to the agent's
 * tracked read waterline when the caller omits `seenUpToSeq`, so a client can't
 * skip alignment merely by not supplying it. These tests drive the real server
 * (no stubbing) end-to-end.
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

describe("channel alignment (server-enforced)", () => {
  it("blocks a send when the agent has unseen messages, even without seenUpToSeq", async () => {
    const { s, agentId, ref } = await setup();
    // Someone else posts; the agent has NOT pulled, so its readMark is behind.
    await s.postMessage({ channel: ref, sender: "@gustavo", text: "hello" });

    const res = await s.send({ agentId, channel: ref, content: { text: "hi" } });
    expect(res.state).toBe("blocked");
    if (res.state === "blocked") {
      expect(res.reason).toBe("unaligned");
      expect(res.unreadCount).toBeGreaterThan(0);
      expect(res.latestSeq).toBeGreaterThan(0);
    }
  });

  it("allows the send once the agent has pulled (aligned to latest)", async () => {
    const { s, agentId, ref } = await setup();
    await s.postMessage({ channel: ref, sender: "@gustavo", text: "hello" });

    // Agent aligns by pulling its inbox (advances the read waterline).
    const { messages } = await s.inboxPull({ agentId, max: 50 });
    const cursors = messages.map((m) => ({ channel: m.channel, seq: Number(m.seq.replace("#", "")) }));
    await s.ack({ agentId, cursors });

    const res = await s.send({ agentId, channel: ref, content: { text: "hi" } });
    expect(res.state).toBe("sent");
  });

  it("re-blocks if a new message arrives after alignment", async () => {
    const { s, agentId, ref } = await setup();
    await s.postMessage({ channel: ref, sender: "@gustavo", text: "first" });
    const { messages } = await s.inboxPull({ agentId, max: 50 });
    await s.ack({
      agentId,
      cursors: messages.map((m) => ({ channel: m.channel, seq: Number(m.seq.replace("#", "")) })),
    });
    // A newer message lands before the agent sends.
    await s.postMessage({ channel: ref, sender: "@devon", text: "second" });

    const res = await s.send({ agentId, channel: ref, content: { text: "hi" } });
    expect(res.state).toBe("blocked");
  });
});
