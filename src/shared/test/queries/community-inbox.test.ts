import { describe, it, expect, vi } from "vitest";
import * as inboxQueries from "../../src/db/queries/community/inbox";

// These tests pin the shape of the public API; SQL behavior is covered by
// integration runs against D1. The fact that this file imports cleanly
// also surfaces accidental query syntax regressions at typecheck time.

describe("community/inbox exports", () => {
  it("exports listUnreadChannels", () => {
    expect(typeof inboxQueries.listUnreadChannels).toBe("function");
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
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1");
    expect(result).toEqual([]);
  });

  it("channels with no read-state row and a lastMessageAt surface as unread", async () => {
    // Pre-fix behaviour path: a channel the user has never opened. The
    // author-watermark write in createMessage is what keeps a user's OWN sends
    // out of this bucket — but any channel the user hasn't touched should
    // still surface here.
    const db = createUnreadRowMock([
      {
        channelId: "ch_new",
        channelName: "brand new",
        serverId: "srv_1",
        serverName: "server 1",
        lastMessageAt: "2026-07-06T00:00:00.000Z",
        lastReadAt: null,
        archived: false,
      },
    ]);
    const result = await inboxQueries.listUnreadChannels(db, "u_1");
    expect(result).toHaveLength(1);
    expect(result[0]!.channelId).toBe("ch_new");
  });
});
