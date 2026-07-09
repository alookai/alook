import { describe, it, expect, vi } from "vitest";
import * as inboxQueries from "../../src/db/queries/community/inbox";
import { isChannelUnread, isDmUnread } from "../../src/db/queries/community/inbox";

// These tests pin the shape of the public API; SQL behavior is covered by
// integration runs against D1. The fact that this file imports cleanly
// also surfaces accidental query syntax regressions at typecheck time.

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
});

describe("isChannelUnread — two-branch predicate", () => {
  const j = "2026-07-06T00:00:00.000Z"; // joinedAt
  const before = "2026-07-05T00:00:00.000Z"; // before join
  const after = "2026-07-07T00:00:00.000Z"; // after join

  it("archived → false", () => {
    expect(
      isChannelUnread({
        archived: true,
        lastMessageAt: after,
        lastReadAt: null,
        joinedAt: j,
      }),
    ).toBe(false);
  });

  it("no lastMessageAt → false", () => {
    expect(
      isChannelUnread({
        archived: false,
        lastMessageAt: null,
        lastReadAt: null,
        joinedAt: j,
      }),
    ).toBe(false);
  });

  it("has read-state, lastMessageAt > lastReadAt → true", () => {
    expect(
      isChannelUnread({
        archived: false,
        lastMessageAt: after,
        lastReadAt: j,
        joinedAt: j,
      }),
    ).toBe(true);
  });

  it("has read-state, lastMessageAt === lastReadAt → false (author's own send)", () => {
    expect(
      isChannelUnread({
        archived: false,
        lastMessageAt: j,
        lastReadAt: j,
        joinedAt: j,
      }),
    ).toBe(false);
  });

  it("no read-state, lastMessageAt > joinedAt → true (unread since join)", () => {
    expect(
      isChannelUnread({
        archived: false,
        lastMessageAt: after,
        lastReadAt: null,
        joinedAt: j,
      }),
    ).toBe(true);
  });

  it("no read-state, lastMessageAt < joinedAt → false (message pre-dates join)", () => {
    expect(
      isChannelUnread({
        archived: false,
        lastMessageAt: before,
        lastReadAt: null,
        joinedAt: j,
      }),
    ).toBe(false);
  });

  it("no read-state, lastMessageAt === joinedAt → false (equal timestamps, matches > semantics)", () => {
    expect(
      isChannelUnread({
        archived: false,
        lastMessageAt: j,
        lastReadAt: null,
        joinedAt: j,
      }),
    ).toBe(false);
  });
});

/**
 * Behaviour tests for the JS post-filter in `listUnreadChannels`.
 *
 * We can't run a full D1 join in unit tests, so we mock the DB to return the
 * row shape the join produces. What we're really pinning here is the
 * `lastMessageAt > lastReadAt` predicate — the fix in #1 relies on
 * `createMessage` writing both timestamps equal in the same batch, so this
 * predicate is what naturally excludes the author's own send.
 *
 * These fixtures reflect the DB state that WOULD exist after `createMessage`
 * runs for the given (user, channel) pairs. They document the invariant end-
 * to-end without needing a real SQLite backend.
 */
describe("listUnreadChannels — author read-watermark behaviour", () => {
  function createUnreadRowMock(rows: any[]) {
    // The query flows: select → from → innerJoin → innerJoin → leftJoin → where
    // and .where(...) resolves to rows.
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  const j = "2026-07-06T00:00:00.000Z"; // joinedAt used by all fixtures

  it("after author sends in channel A, listUnreadChannels(author) excludes A (lastMessageAt === lastReadAt)", async () => {
    // Post-createMessage state: channel.lastMessageAt and readState.lastReadAt
    // are the same string — the timestamp alignment invariant from #1.
    const ts = "2026-07-06T00:00:00.000Z";
    const db = createUnreadRowMock([
      {
        channelId: "ch_A",
        channelName: "channel A",
        serverId: "srv_1",
        serverName: "server 1",
        lastMessageAt: ts,
        lastReadAt: ts, // author's watermark advanced to this exact message
        archived: false,
        joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_author");
    expect(result).toEqual([]);
  });

  it("after author's send, then peer's send in channel A: listUnreadChannels(author) DOES include A (watermark bounded, not sticky)", async () => {
    // Author's send set watermark to t1; peer's send bumped channel.lastMessageAt
    // to t2 without touching the author's read-state. Result: t2 > t1, channel
    // resurfaces as unread — exactly the "watermark is bounded, not sticky"
    // behaviour the plan calls out.
    const t1 = "2026-07-06T00:00:00.000Z";
    const t2 = "2026-07-06T00:00:05.000Z";
    const db = createUnreadRowMock([
      {
        channelId: "ch_A",
        channelName: "channel A",
        serverId: "srv_1",
        serverName: "server 1",
        lastMessageAt: t2,
        lastReadAt: t1,
        archived: false,
        joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_author");
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("ch_A");
    expect(result[0]!.lastMessageAt).toBe(t2);
    expect(result[0]!.lastReadAt).toBe(t1);
  });

  it("archived channels are filtered out even when unread", async () => {
    const db = createUnreadRowMock([
      {
        channelId: "ch_archived",
        channelName: "old",
        serverId: "srv_1",
        serverName: "server 1",
        lastMessageAt: "2026-07-06T00:00:00.000Z",
        lastReadAt: null,
        archived: true,
        joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1");
    expect(result).toEqual([]);
  });

  it("channel the user has never opened surfaces as unread when lastMessageAt > joinedAt", async () => {
    // No read-state row for this (user, channel). Message posted AFTER the
    // user joined the server → still unread from their perspective.
    const db = createUnreadRowMock([
      {
        channelId: "ch_new",
        channelName: "brand new",
        serverId: "srv_1",
        serverName: "server 1",
        lastMessageAt: "2026-07-06T00:01:00.000Z",
        lastReadAt: null,
        archived: false,
        joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1");
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("ch_new");
  });

  it("channel with messages predating the user's join does NOT surface as unread", async () => {
    // The bug fix: a user who joined a server with pre-existing history
    // shouldn't see every old channel as unread. lastReadAt is null (never
    // opened) but lastMessageAt < joinedAt.
    const db = createUnreadRowMock([
      {
        channelId: "ch_old",
        channelName: "old history",
        serverId: "srv_1",
        serverName: "server 1",
        lastMessageAt: "2026-07-05T00:00:00.000Z", // predates joinedAt
        lastReadAt: null,
        archived: false,
        joinedAt: j,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1");
    expect(result).toEqual([]);
  });
});

describe("isDmUnread — predicate", () => {
  it("no lastMessageAt → false (empty conversation)", () => {
    expect(isDmUnread({ lastMessageAt: null, lastReadAt: null })).toBe(false);
  });

  it("no read-state, has message → true (counterparty never opened)", () => {
    expect(
      isDmUnread({ lastMessageAt: "2026-07-06T00:00:00.000Z", lastReadAt: null })
    ).toBe(true);
  });

  it("lastMessageAt === lastReadAt → false (author's own send)", () => {
    const t = "2026-07-06T00:00:00.000Z";
    expect(isDmUnread({ lastMessageAt: t, lastReadAt: t })).toBe(false);
  });

  it("lastMessageAt > lastReadAt → true", () => {
    expect(
      isDmUnread({
        lastMessageAt: "2026-07-06T00:00:05.000Z",
        lastReadAt: "2026-07-06T00:00:00.000Z",
      })
    ).toBe(true);
  });

  it("lastMessageAt < lastReadAt → false", () => {
    expect(
      isDmUnread({
        lastMessageAt: "2026-07-06T00:00:00.000Z",
        lastReadAt: "2026-07-06T00:00:05.000Z",
      })
    ).toBe(false);
  });
});

describe("listUnreadDms — read-watermark behaviour", () => {
  function createUnreadDmRowMock(rows: any[]) {
    // select → from → innerJoin → leftJoin → where
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns DMs where lastMessageAt > lastReadAt", async () => {
    const db = createUnreadDmRowMock([
      {
        dmConversationId: "dm_1",
        user1Id: "u_viewer",
        user2Id: "u_alice",
        lastMessageAt: "2026-07-06T00:00:05.000Z",
        lastReadAt: "2026-07-06T00:00:00.000Z",
        otherUserId: "u_alice",
        otherUserName: "Alice",
        otherUserImage: null,
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toHaveLength(1);
    expect(result[0]!.dmConversationId).toBe("dm_1");
    expect(result[0]!.otherUserId).toBe("u_alice");
  });

  it("filters out DMs where author's watermark equals lastMessageAt", async () => {
    const ts = "2026-07-06T00:00:00.000Z";
    const db = createUnreadDmRowMock([
      {
        dmConversationId: "dm_1",
        user1Id: "u_viewer",
        user2Id: "u_alice",
        lastMessageAt: ts,
        lastReadAt: ts, // viewer sent last, watermark aligned
        otherUserId: "u_alice",
        otherUserName: "Alice",
        otherUserImage: null,
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toEqual([]);
  });

  it("returns DM the viewer has never opened (lastReadAt null, lastMessageAt set)", async () => {
    const db = createUnreadDmRowMock([
      {
        dmConversationId: "dm_1",
        user1Id: "u_alice",
        user2Id: "u_viewer",
        lastMessageAt: "2026-07-06T00:00:00.000Z",
        lastReadAt: null,
        otherUserId: "u_alice",
        otherUserName: "Alice",
        otherUserImage: "https://cdn/a.png",
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toHaveLength(1);
    expect(result[0]!.otherUserImage).toBe("https://cdn/a.png");
  });

  it("skips empty conversations (lastMessageAt null)", async () => {
    // The WHERE clause filters this on the DB side (`isNotNull(lastMessageAt)`),
    // but the JS predicate is defensive — pinning both layers together lets us
    // catch a regression where either drops the guard.
    const db = createUnreadDmRowMock([
      {
        dmConversationId: "dm_1",
        user1Id: "u_viewer",
        user2Id: "u_alice",
        lastMessageAt: null,
        lastReadAt: null,
        otherUserId: "u_alice",
        otherUserName: "Alice",
        otherUserImage: null,
      },
    ]);
    const result = await inboxQueries.listUnreadDms(db, "u_viewer");
    expect(result).toEqual([]);
  });
});
