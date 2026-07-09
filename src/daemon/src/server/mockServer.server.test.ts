import { describe, it, expect } from "vitest";
import { MockServer } from "./mockServer";
import { computeDiscriminator } from "@alook/shared/lib/discriminator";

/**
 * `MockServer`'s invite/join surface — the owner-check branch (the thing
 * `alook server join` is actually about). Expiry/max-uses are NOT modeled
 * here — see plans/community-server-cli-subcommands.md "Out of scope".
 */
describe("MockServer — createInvite + joinServer", () => {
  it("an agent whose owner matches invite.createdBy joins successfully; membership gains the agent", async () => {
    const s = new MockServer();
    const { user: owner } = await s.createUser({ name: "gustavo" });
    const { server } = await s.createServer({ name: "Design Studio" });
    const { agent } = await s.createAgent({ userId: owner.id, name: "bot", runtime: "mock" });

    const { token } = await s.createInvite({ server: server.id, createdBy: owner.id });
    const { server: joined } = await s.joinServer({ agentId: agent.id, invite: token });

    expect(joined).toEqual(server);
    const { members } = await s.listMembers({ agentId: agent.id, server: server.id });
    expect(members).toEqual([{ handle: `bot#${computeDiscriminator(agent.id)}`, role: "member" }]);
  });

  it("joinServer with wrong owner throws FORBIDDEN with a .hint string attached", async () => {
    const s = new MockServer();
    const { user: owner } = await s.createUser({ name: "gustavo" });
    const { user: stranger } = await s.createUser({ name: "zztop" });
    const { server } = await s.createServer({ name: "Design Studio" });
    const { agent } = await s.createAgent({ userId: owner.id, name: "bot", runtime: "mock" });

    const { token } = await s.createInvite({ server: server.id, createdBy: stranger.id });

    await expect(s.joinServer({ agentId: agent.id, invite: token })).rejects.toMatchObject({
      code: "FORBIDDEN",
      hint: expect.stringContaining("Ask your owner"),
    });
  });

  it("joinServer with an unknown token throws NOT_FOUND", async () => {
    const s = new MockServer();
    const { user: owner } = await s.createUser({ name: "gustavo" });
    const { agent } = await s.createAgent({ userId: owner.id, name: "bot", runtime: "mock" });

    await expect(s.joinServer({ agentId: agent.id, invite: "does-not-exist" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("listMembers returns handles for every agent currently in the server's membership set", async () => {
    const s = new MockServer();
    const { user: owner } = await s.createUser({ name: "gustavo" });
    const { server } = await s.createServer({ name: "Design Studio" });
    const { agent: a } = await s.createAgent({ userId: owner.id, name: "alex", runtime: "mock" });
    const { agent: b } = await s.createAgent({ userId: owner.id, name: "sam", runtime: "mock" });

    const { token: tokenA } = await s.createInvite({ server: server.id, createdBy: owner.id });
    await s.joinServer({ agentId: a.id, invite: tokenA });
    const { token: tokenB } = await s.createInvite({ server: server.id, createdBy: owner.id });
    await s.joinServer({ agentId: b.id, invite: tokenB });

    const { members } = await s.listMembers({ agentId: a.id, server: server.id });
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.role === "member")).toBe(true);
    const handles = members.map((m) => m.handle);
    expect(handles).toContain(`alex#${computeDiscriminator(a.id)}`);
    expect(handles).toContain(`sam#${computeDiscriminator(b.id)}`);
  });
});
