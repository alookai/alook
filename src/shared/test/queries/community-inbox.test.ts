import { describe, it, expect, vi } from "vitest";
import * as inboxQueries from "../../src/db/queries/community/inbox";
import { isChannelUnread, isDmUnread } from "../../src/db/queries/community/inbox";

// These tests pin the shape of the public API; SQL behavior is covered by
// integration runs against D1. The fact that this file imports cleanly
// also surfaces accidental query syntax regressions at typecheck time.
//
// ref/id read-model seq unification: the unread predicate now compares SEQ
// (`EXISTS(message.seq > lastReadSeq)`, computed in SQL) instead of the old
// `lastMessageAt > lastReadAt` timestamp. The pure predicates take the SQL
// results — `hasReadState` (is there a read-state row) + `hasUnreadBeyondSeq`
// (the EXISTS result) — and the no-read-state branch still uses `joinedAt`
// (channels) / "any message" (DMs), which are orthogonal to the seq switch.

describe("community/inbox exports", () => {
  it("exports listUnreadChannels", () => {
    expect(typeof inboxQueries.listUnreadChannels).toBe("function");
  });
  it("exports isChannelUnread", () => {
    expect(typeof inboxQueries.isChannelUnread).toBe("function");
  });
  it("exports listUnreadDms", () => {
    expect(typeof inboxQueries.listUnreadDms).toBe("function");
  });
  it("exports isDmUnread", () => {
    expect(typeof inboxQueries.isDmUnread).toBe("function");
  });
  it("exports listUnreadForumOpeners", () => {
    expect(typeof inboxQueries.listUnreadForumOpeners).toBe("function");
  });

  it("exports listForumOpenersByChildIds", () => {
    expect(typeof inboxQueries.listForumOpenersByChildIds).toBe("function");
  });
});

describe("isChannelUnread — two-branch predicate (seq)", () => {
  const j = "2026-07-06T00:00:00.000Z"; // joinedAt
  const before = "2026-07-05T00:00:00.000Z"; // before join
  const after = "2026-07-07T00:00:00.000Z"; // after join

  it("archived → false", () => {
    expect(
      isChannelUnread({ archived: true, lastMessageAt: after, hasReadState: false, hasUnreadBeyondSeq: true, joinedAt: j }),
    ).toBe(false);
  });

  it("no lastMessageAt → false", () => {
    expect(
      isChannelUnread({ archived: false, lastMessageAt: null, hasReadState: false, hasUnreadBeyondSeq: false, joinedAt: j }),
    ).toBe(false);
  });

  it("has read-state, a message beyond lastReadSeq exists → true", () => {
    expect(
      isChannelUnread({ archived: false, lastMessageAt: after, hasReadState: true, hasUnreadBeyondSeq: true, joinedAt: j }),
    ).toBe(true);
  });

  it("has read-state, nothing beyond lastReadSeq → false (caught up / author's own send)", () => {
    // createMessage advances the author's own lastReadSeq to the message's seq
    // in the same batch, so the author's own send yields no seq beyond cursor.
    expect(
      isChannelUnread({ archived: false, lastMessageAt: j, hasReadState: true, hasUnreadBeyondSeq: false, joinedAt: j }),
    ).toBe(false);
  });

  it("no read-state, lastMessageAt > joinedAt → true (unread since join)", () => {
    expect(
      isChannelUnread({ archived: false, lastMessageAt: after, hasReadState: false, hasUnreadBeyondSeq: false, joinedAt: j }),
    ).toBe(true);
  });

  it("no read-state, lastMessageAt < joinedAt → false (message pre-dates join)", () => {
    expect(
      isChannelUnread({ archived: false, lastMessageAt: before, hasReadState: false, hasUnreadBeyondSeq: false, joinedAt: j }),
    ).toBe(false);
  });

  it("no read-state, lastMessageAt === joinedAt → false (equal timestamps, matches > semantics)", () => {
    expect(
      isChannelUnread({ archived: false, lastMessageAt: j, hasReadState: false, hasUnreadBeyondSeq: false, joinedAt: j }),
    ).toBe(false);
  });

  it("has read-state takes the seq branch even when lastMessageAt < joinedAt (branch precedence)", () => {
    // With a read-state row, the joinedAt branch never runs — the seq EXISTS
    // is authoritative. A pre-join lastMessageAt with hasUnreadBeyondSeq=false
    // is not unread; the joinedAt comparison is irrelevant here.
    expect(
      isChannelUnread({ archived: false, lastMessageAt: before, hasReadState: true, hasUnreadBeyondSeq: false, joinedAt: j }),
    ).toBe(false);
  });
});

/**
 * Behaviour tests for the JS post-filter in `listUnreadChannels`. We can't run a
 * full D1 join in unit tests, so we mock the DB to return the row shape the join
 * produces — now carrying `hasReadState` / `hasUnreadBeyondSeq` (the SQL-computed
 * 0/1 flags) rather than `lastReadAt`. These document the seq predicate end-to-end
 * without a real SQLite backend.
 */
describe("listUnreadChannels — seq read-watermark behaviour", () => {
  function createUnreadRowMock(rows: any[]) {
    // select → from → innerJoin → innerJoin → leftJoin → where; .where resolves rows.
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  const j = "2026-07-06T00:00:00.000Z"; // joinedAt used by all fixtures

  it("author is caught up in channel A (nothing beyond lastReadSeq) → excluded", async () => {
    // Post-createMessage state: the author's lastReadSeq == the channel's latest
    // seq, so EXISTS(seq > lastReadSeq) is false (hasUnreadBeyondSeq: 0).
    const db = createUnreadRowMock([
      {
        channelId: "ch_A", channelName: "channel A", serverId: "srv_1", serverName: "server 1",
        parentChannelId: null, lastMessageAt: j, hasReadState: 1, hasUnreadBeyondSeq: 0, archived: false, joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_author", ["ch_A"]);
    expect(result).toEqual([]);
  });

  it("peer's send beyond the author's cursor → channel A resurfaces (watermark bounded, not sticky)", async () => {
    const t2 = "2026-07-06T00:00:05.000Z";
    const db = createUnreadRowMock([
      {
        channelId: "ch_A", channelName: "channel A", serverId: "srv_1", serverName: "server 1",
        type: "forum", parentChannelId: null, lastMessageAt: t2, hasReadState: 1, hasUnreadBeyondSeq: 1, archived: false, joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_author", ["ch_A"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("ch_A");
    expect(result[0]!.lastMessageAt).toBe(t2);
    // `type` is carried through so the inbox can render the entity icon.
    expect(result[0]!.type).toBe("forum");
  });

  it("archived channels are filtered out even when unread", async () => {
    const db = createUnreadRowMock([
      {
        channelId: "ch_archived", channelName: "old", serverId: "srv_1", serverName: "server 1",
        parentChannelId: null, lastMessageAt: "2026-07-06T00:00:00.000Z", hasReadState: 0, hasUnreadBeyondSeq: 0, archived: true, joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1", ["ch_archived"]);
    expect(result).toEqual([]);
  });

  it("channel the user has never opened surfaces as unread when lastMessageAt > joinedAt", async () => {
    // No read-state row (hasReadState: 0) → joinedAt branch. Message after join.
    const db = createUnreadRowMock([
      {
        channelId: "ch_new", channelName: "brand new", serverId: "srv_1", serverName: "server 1",
        parentChannelId: null, lastMessageAt: "2026-07-06T00:01:00.000Z", hasReadState: 0, hasUnreadBeyondSeq: 0, archived: false, joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1", ["ch_new"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("ch_new");
  });

  it("channel with messages predating the user's join does NOT surface as unread", async () => {
    // No read-state row, lastMessageAt < joinedAt → joinedAt branch excludes it.
    const db = createUnreadRowMock([
      {
        channelId: "ch_old", channelName: "old history", serverId: "srv_1", serverName: "server 1",
        parentChannelId: null, lastMessageAt: "2026-07-05T00:00:00.000Z", hasReadState: 0, hasUnreadBeyondSeq: 0, archived: false, joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1", ["ch_old"]);
    expect(result).toEqual([]);
  });

  // Thread unreads are scoped to PARTICIPATION. The function issues a SECOND
  // query (listParticipatingThreadIds) when the unread set contains threads.
  function createTwoQueryMock(unreadRows: any[], participatingThreadIds: string[]) {
    let call = 0;
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call === 1 ? unreadRows : participatingThreadIds.map((id) => ({ channelId: id }))
      );
    });
    return chain;
  }

  const unreadThreadRow = (channelId: string) => ({
    channelId, channelName: "a thread", serverId: "srv_1", serverName: "server 1",
    type: "thread", parentChannelId: "ch_parent", lastMessageAt: "2026-07-06T00:00:05.000Z",
    hasReadState: 1, hasUnreadBeyondSeq: 1, archived: false, joinedAt: j,
  });

  it("thread the viewer participates in surfaces as unread", async () => {
    const db = createTwoQueryMock([unreadThreadRow("t_in")], ["t_in"]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1", ["t_in"]);
    expect(result.map((r) => r.channelId)).toEqual(["t_in"]);
  });

  it("thread the viewer does NOT participate in is filtered out (even if unread)", async () => {
    const db = createTwoQueryMock([unreadThreadRow("t_out")], []);
    const result = await inboxQueries.listUnreadChannels(db, "u_1", ["t_out"]);
    expect(result).toEqual([]);
  });

});

describe("listUnreadForumOpeners — scoped forum projection", () => {
  function createForumOpenerMock(responseSets: any[][]) {
    let call = 0;
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(responseSets[call++] ?? []));
    return chain;
  }

  const raw = (overrides: Partial<{
    forumChannelId: string;
    openerMessageId: string;
    openerContent: string;
    openerSeq: number;
    childChannelId: string;
    childName: string | null;
    createdAt: string;
  }> = {}) => ({
    forumChannelId: "forum_1",
    openerMessageId: "opener_1",
    openerContent: "The authoritative full opener title",
    openerSeq: 1,
    childChannelId: "post_1",
    childName: "derived truncated title",
    createdAt: "2026-07-07T10:00:00.000Z",
    ...overrides,
  });

  it("returns no rows and issues no query for an empty authorized parent scope", async () => {
    const db = createForumOpenerMock([]);
    await expect(inboxQueries.listUnreadForumOpeners(db, "u1", [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("projects opener identity, child identity, full opener content, createdAt, and seq", async () => {
    const db = createForumOpenerMock([[raw()]]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ["forum_1"]);
    expect(result).toEqual([{
      forumChannelId: "forum_1",
      openerMessageId: "opener_1",
      childChannelId: "post_1",
      title: "The authoritative full opener title",
      createdAt: "2026-07-07T10:00:00.000Z",
      openerSeq: 1,
    }]);
  });

  it("falls back to the derived child name only when opener content is blank", async () => {
    const db = createForumOpenerMock([[
      raw({ openerMessageId: "blank", openerContent: "  ", childName: "Fallback title" }),
      raw({ openerMessageId: "full", openerContent: "  preserve me  ", childName: "Wrong" }),
    ]]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ["forum_1"]);
    expect(Object.fromEntries(result.map((row) => [row.openerMessageId, row.title]))).toEqual({
      blank: "Fallback title",
      full: "  preserve me  ",
    });
  });

  it("chunks the authorized id scope and globally sorts createdAt, seq, then id", async () => {
    const firstChunk = [
      raw({ openerMessageId: "opener_a", openerSeq: 4, createdAt: "2026-07-07T10:00:00.000Z" }),
      raw({ openerMessageId: "opener_z", openerSeq: 8, createdAt: "2026-07-07T09:00:00.000Z" }),
    ];
    const secondChunk = [
      raw({ openerMessageId: "opener_b", openerSeq: 5, createdAt: "2026-07-07T10:00:00.000Z" }),
      raw({ openerMessageId: "opener_c", openerSeq: 5, createdAt: "2026-07-07T10:00:00.000Z" }),
    ];
    const db = createForumOpenerMock([firstChunk, secondChunk]);
    const ids = Array.from({ length: 91 }, (_, i) => `forum_${i}`);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ids);

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(result.map((row) => row.openerMessageId)).toEqual([
      "opener_c",
      "opener_b",
      "opener_a",
      "opener_z",
    ]);
  });
});

describe("listForumOpenersByChildIds — structurally validated child projection", () => {
  function createChildOpenerMock(responseSets: any[][]) {
    let call = 0;
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(responseSets[call++] ?? []));
    return chain;
  }

  const raw = (overrides: Record<string, unknown> = {}) => ({
    forumChannelId: "forum_1",
    openerMessageId: "opener_1",
    openerContent: "Canonical title",
    openerSeq: 7,
    childChannelId: "post_1",
    childName: "derived",
    createdAt: "2026-07-07T10:00:00.000Z",
    ...overrides,
  });

  it("does not query for an empty authorized child scope", async () => {
    const db = createChildOpenerMock([]);
    await expect(inboxQueries.listForumOpenersByChildIds(db, [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns full canonical content and falls back only for blank content", async () => {
    const db = createChildOpenerMock([[
      raw(),
      raw({ openerMessageId: "blank", childChannelId: "post_2", openerContent: "  ", childName: "Fallback" }),
    ]]);
    const rows = await inboxQueries.listForumOpenersByChildIds(db, ["post_1", "post_2"]);
    expect(rows.map((row) => [row.childChannelId, row.title])).toEqual([
      ["post_1", "Canonical title"],
      ["post_2", "Fallback"],
    ]);
    expect(db.innerJoin).toHaveBeenCalledTimes(2);
  });

  it("chunks the bounded child id set and globally sorts results", async () => {
    const db = createChildOpenerMock([[
      raw({ openerMessageId: "older", childChannelId: "post_old", createdAt: "2026-07-07T09:00:00.000Z" }),
    ], [
      raw({ openerMessageId: "newer", childChannelId: "post_new", createdAt: "2026-07-07T11:00:00.000Z" }),
    ]]);
    const ids = Array.from({ length: 91 }, (_, index) => `post_${index}`);
    const rows = await inboxQueries.listForumOpenersByChildIds(db, ids);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.openerMessageId)).toEqual(["newer", "older"]);
  });
});

describe("isDmUnread — predicate (seq)", () => {
  it("no lastMessageAt → false (empty conversation)", () => {
    expect(isDmUnread({ lastMessageAt: null, hasReadState: false, hasUnreadBeyondSeq: false })).toBe(false);
  });

  it("no read-state, has message → true (counterparty never opened)", () => {
    expect(
      isDmUnread({ lastMessageAt: "2026-07-06T00:00:00.000Z", hasReadState: false, hasUnreadBeyondSeq: false })
    ).toBe(true);
  });

  it("has read-state, nothing beyond lastReadSeq → false (caught up / own send)", () => {
    const t = "2026-07-06T00:00:00.000Z";
    expect(isDmUnread({ lastMessageAt: t, hasReadState: true, hasUnreadBeyondSeq: false })).toBe(false);
  });

  it("has read-state, a message beyond lastReadSeq → true", () => {
    expect(
      isDmUnread({ lastMessageAt: "2026-07-06T00:00:05.000Z", hasReadState: true, hasUnreadBeyondSeq: true })
    ).toBe(true);
  });
});

describe("listUnreadDms — seq read-watermark behaviour", () => {
  function createUnreadDmRowMock(rows: any[]) {
    // selfRows select → then the main select → from → innerJoin → leftJoin → where.
    // Both `.where()` resolutions return `rows`; selfRows only reads `channelId`.
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns DMs with a message beyond the viewer's lastReadSeq", async () => {
    const db = createUnreadDmRowMock([
      {
        channelId: "dm_ch_1", lastMessageAt: "2026-07-06T00:00:05.000Z",
        hasReadState: 1, hasUnreadBeyondSeq: 1, otherUserId: "u_alice", otherUserName: "Alice", otherUserDiscriminator: "1111", otherUserImage: null,
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("dm_ch_1");
    expect(result[0]!.otherUserId).toBe("u_alice");
    expect(result[0]!.otherUserDiscriminator).toBe("1111");
  });

  it("filters out DMs where the viewer is caught up (nothing beyond lastReadSeq)", async () => {
    const ts = "2026-07-06T00:00:00.000Z";
    const db = createUnreadDmRowMock([
      {
        channelId: "dm_ch_1", lastMessageAt: ts,
        hasReadState: 1, hasUnreadBeyondSeq: 0, otherUserId: "u_alice", otherUserName: "Alice", otherUserDiscriminator: "1111", otherUserImage: null,
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toEqual([]);
  });

  it("returns DM the viewer has never opened (no read-state row, message present)", async () => {
    const db = createUnreadDmRowMock([
      {
        channelId: "dm_ch_1", lastMessageAt: "2026-07-06T00:00:00.000Z",
        hasReadState: 0, hasUnreadBeyondSeq: 0, otherUserId: "u_alice", otherUserName: "Alice", otherUserDiscriminator: "1111", otherUserImage: "https://cdn/a.png",
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toHaveLength(1);
    expect(result[0]!.otherUserImage).toBe("https://cdn/a.png");
  });

  it("skips empty conversations (lastMessageAt null)", async () => {
    const db = createUnreadDmRowMock([
      {
        channelId: "dm_ch_1", lastMessageAt: null,
        hasReadState: 0, hasUnreadBeyondSeq: 0, otherUserId: "u_alice", otherUserName: "Alice", otherUserDiscriminator: "1111", otherUserImage: null,
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toEqual([]);
  });
});
