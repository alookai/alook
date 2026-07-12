import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as channelQueries from "../../src/db/queries/community/channel";
import { canSeePrivateChannel } from "../../src/utils/community-roles";

function channelRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    serverId: "s1",
    categoryId: null,
    name: "chan",
    type: "text",
    topic: "",
    position: 0,
    forumTags: null,
    parentChannelId: null,
    creatorId: "creator",
    messageCount: 0,
    archived: 0,
    parentMessageId: null,
    lastMessageAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * Sequenced select mock: `queue` holds the resolved rows for each select() in
 * call order. getChannelForMember issues: (1) channel+member join → (2) anchor
 * + category-private join → (3, optional) isChannelMember lookup.
 */
function makeSeqDb(queue: any[][]) {
  let i = 0;
  const db: any = {
    select: vi.fn(() => {
      const rows = queue[i++] ?? [];
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
      chain.limit = vi.fn(() => Promise.resolve(rows));
      chain.orderBy = vi.fn(() => Promise.resolve(rows));
      return chain;
    }),
  };
  return db;
}

describe("canSeePrivateChannel — shared rule", () => {
  it("admin/owner sees it regardless of membership", () => {
    expect(canSeePrivateChannel({ role: "admin", isCreator: false, isChannelMember: false })).toBe(true)
    expect(canSeePrivateChannel({ role: "owner", isCreator: false, isChannelMember: false })).toBe(true)
  })
  it("creator sees it", () => {
    expect(canSeePrivateChannel({ role: "member", isCreator: true, isChannelMember: false })).toBe(true)
  })
  it("added member sees it", () => {
    expect(canSeePrivateChannel({ role: "member", isCreator: false, isChannelMember: true })).toBe(true)
  })
  it("unrelated member cannot", () => {
    expect(canSeePrivateChannel({ role: "member", isCreator: false, isChannelMember: false })).toBe(false)
  })
})

describe("getChannelForMember — private visibility", () => {
  it("non-server-member → null (empty join)", async () => {
    const db = makeSeqDb([[]]);
    expect(await channelQueries.getChannelForMember(db, "c1", "u1")).toBeNull();
  });

  it("public channel → returns the channel for any member", async () => {
    const db = makeSeqDb([
      [{ ...channelRow({ categoryId: null }), memberRole: "member" }],
      [{ creatorId: "creator", categoryPrivate: 0 }],
    ]);
    const res = await channelQueries.getChannelForMember(db, "c1", "u1");
    expect(res?.id).toBe("c1");
  });

  it("private channel + non-member, non-creator, non-admin → null", async () => {
    const db = makeSeqDb([
      [{ ...channelRow({ categoryId: "cat1" }), memberRole: "member" }],
      [{ creatorId: "creator", categoryPrivate: 1 }],
      [], // isChannelMember → no row
    ]);
    expect(await channelQueries.getChannelForMember(db, "c1", "u1")).toBeNull();
  });

  it("private channel + admin → returns the channel without a member row", async () => {
    const db = makeSeqDb([
      [{ ...channelRow({ categoryId: "cat1" }), memberRole: "admin" }],
      [{ creatorId: "creator", categoryPrivate: 1 }],
    ]);
    const res = await channelQueries.getChannelForMember(db, "c1", "u1");
    expect(res?.id).toBe("c1");
  });

  it("private channel + creator → returns the channel", async () => {
    const db = makeSeqDb([
      [{ ...channelRow({ categoryId: "cat1", creatorId: "u1" }), memberRole: "member" }],
      [{ creatorId: "u1", categoryPrivate: 1 }],
    ]);
    const res = await channelQueries.getChannelForMember(db, "c1", "u1");
    expect(res?.id).toBe("c1");
  });

  it("private channel + added member → returns the channel", async () => {
    const db = makeSeqDb([
      [{ ...channelRow({ categoryId: "cat1" }), memberRole: "member" }],
      [{ creatorId: "creator", categoryPrivate: 1 }],
      [{ id: "cm1" }], // isChannelMember → row present
    ]);
    const res = await channelQueries.getChannelForMember(db, "c1", "u1");
    expect(res?.id).toBe("c1");
  });

  it("strips the joined memberRole from the returned row", async () => {
    const db = makeSeqDb([
      [{ ...channelRow(), memberRole: "member" }],
      [{ creatorId: "creator", categoryPrivate: 0 }],
    ]);
    const res = await channelQueries.getChannelForMember(db, "c1", "u1");
    expect(res).not.toHaveProperty("memberRole");
    expect(res).toHaveProperty("tags");
  });
});
