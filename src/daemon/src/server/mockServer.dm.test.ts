import { describe, it, expect } from "vitest";
import { MockServer } from "./mockServer";
import { computeDiscriminator } from "@alook/shared/lib/discriminator";

/**
 * `MockServer` resolves DM peers by a different scheme than production
 * `resolve-ref.ts` — this file proves both `createAgent` (deterministic
 * `computeDiscriminator`) and seeded `members` produce `@name#0042` handles
 * that `membersOf`/`post`/`send` round-trip through the `/.dm/<handle>`
 * ref format.
 */
describe("MockServer — DM handle resolution", () => {
  it("membersOf resolves a /.dm/name#0042 ref built from createAgent's handle", async () => {
    const s = new MockServer();
    const { user } = await s.createUser({ name: "u" });
    const { agent } = await s.createAgent({ userId: user.id, name: "cindy", runtime: "mock" });

    const discriminator = computeDiscriminator(agent.id);
    const dmRef = `/.dm/cindy#${discriminator}`;

    expect(s.membersOf(dmRef)).toEqual([agent.id]);
  });

  it("a post/send round-trip through a DM ref built from the handle format works end-to-end", async () => {
    const s = new MockServer();
    const { user } = await s.createUser({ name: "u" });
    const { agent } = await s.createAgent({ userId: user.id, name: "cindy", runtime: "mock" });
    const discriminator = computeDiscriminator(agent.id);
    const dmRef = `/.dm/cindy#${discriminator}`;

    s.post({ channel: dmRef, sender: "@gustavo#4821", text: "hello" });
    const { messages } = await s.inboxPull({ agentId: agent.id, max: 50 });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender).toBe("@gustavo#4821");
    expect(messages[0]!.channel).toBe(dmRef);

    await s.ack({ agentId: agent.id, cursors: [{ channel: dmRef, seq: 1 }] });
    const res = await s.send({ agentId: agent.id, channel: dmRef, content: { text: "hi back" } });
    expect(res.state).toBe("sent");
    if (res.state === "sent") {
      expect(res.message.sender).toBe(`@cindy#${discriminator}`);
    }
  });

  it("seeded members resolve via their explicit discriminator, defaulting to computeDiscriminator(id) when omitted", async () => {
    const s = new MockServer({
      servers: [],
      members: [
        { id: "agent_a", name: "alex", discriminator: "1111" },
        { id: "agent_b", name: "sam" },
      ],
    });
    expect(s.membersOf("/.dm/alex#1111")).toEqual(["agent_a"]);
    expect(s.membersOf(`/.dm/sam#${computeDiscriminator("agent_b")}`)).toEqual(["agent_b"]);
  });
});
