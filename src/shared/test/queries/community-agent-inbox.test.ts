import { describe, it, expect, vi } from "vitest";
import * as agentInbox from "../../src/db/queries/community/agent-inbox";

/**
 * Generic chainable + thenable mock. Every builder method (`select`, `from`,
 * `where`, `leftJoin`, `orderBy`, `limit`, `groupBy`, ...) returns the same
 * chain object, and the chain itself is a thenable — `await`/`Promise.all`
 * calls `.then()` on it regardless of which method was "last" in the chain,
 * so this one mock covers every shape `agent-inbox.ts` builds (`.where()`
 * terminal, `.limit()` terminal, `.groupBy()` terminal, ...).
 *
 * `db.select()` calls consume `responses` in FIFO call order — i.e. the Nth
 * `db.select(...)` call anywhere in the exercised code resolves to
 * `responses[N]`. See the query module's internal `Promise.all` construction
 * order (documented per-test below) for why this order is deterministic.
 */
function createSequentialDb(responses: unknown[][]) {
  let call = 0;
  const methods = ["from", "where", "leftJoin", "innerJoin", "orderBy", "limit", "groupBy", "as"];
  const select = vi.fn(() => {
    const idx = call++;
    const chain: any = {};
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.then = (resolve: any, reject: any) =>
      Promise.resolve(responses[idx] ?? []).then(resolve, reject);
    return chain;
  });
  return { select } as any;
}

function rawMsg(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m_1",
    authorId: "u_1",
    content: "hello",
    createdAt: "2026-07-01T00:00:00.000Z",
    channelId: "ch_1",
    dmConversationId: null,
    seq: 1,
    ...overrides,
  };
}

describe("getLatestSeqForScope", () => {
  it("returns the counter's nextSeq when a row exists", async () => {
    const db = createSequentialDb([[{ nextSeq: 42 }]]);
    const result = await agentInbox.getLatestSeqForScope(db, "channel:c1");
    expect(result).toBe(42);
  });

  it("returns 0 when no counter row exists yet (scope never messaged in)", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.getLatestSeqForScope(db, "channel:new");
    expect(result).toBe(0);
  });
});

describe("getLatestUnreadMessageForAgent", () => {
  // Call order (visibility+participation prelude, then a single-row messages
  // SQL):
  //  1-3. `listVisibleChannelIdsForUser`
  //  4. Visible-channel types lookup
  //  5. `listParticipatingThreadIds` (only if narrow types among visible)
  //  6. The messages SQL — `ORDER BY createdAt DESC LIMIT 1`
  it("returns null when there's no unread anywhere", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    const result = await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    expect(result).toBeNull();
  });

  it("returns the single most-recent unread message id", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [{ id: "m_latest" }],
    ]);
    const result = await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    expect(result).toEqual({ messageId: "m_latest" });
  });

  it("excludes thread channels the bot isn't a participant of from the messages SQL entirely", async () => {
    // ch_thread is filtered out of `allowedChannelIds` by the pre-narrowing
    // pass, so the messages SQL's WHERE ... inArray(channelId, allowed) can
    // never surface a ch_thread row. `m_text` is the newest allowed row.
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [
        { id: "ch_thread", type: "thread", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: "ch_text" },
        { id: "ch_text", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null },
      ],
      [],
      [
        { id: "ch_thread", type: "thread" },
        { id: "ch_text", type: "text" },
      ],
      [], // bot isn't a participant of ch_thread → dropped from allowed set
      [{ id: "m_text" }], // messages SQL only ever sees ch_text
    ]);
    const result = await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    expect(result).toEqual({ messageId: "m_text" });
  });

  it("orders by createdAt desc and asks for a single row (allowed-set is pre-narrowed, no post-filter window needed)", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    const chainResult = db.select.mock.results[4]!.value;
    expect(chainResult.orderBy).toHaveBeenCalledTimes(1);
    expect(chainResult.limit).toHaveBeenCalledWith(1);
  });

  it("joins only dm + read-state on the messages SQL (visibility & participation are pre-narrowed)", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    const chainResult = db.select.mock.results[4]!.value;
    // dm + read-state.
    expect(chainResult.leftJoin).toHaveBeenCalledTimes(2);
    expect(chainResult.leftJoin.mock.invocationCallOrder[0]).toBeLessThan(
      chainResult.where.mock.invocationCallOrder[0]
    );
  });
});

describe("resolveUnreadNoticeChannel", () => {
  it("channel scope: returns the channel id when the channel + server resolve", async () => {
    // Call order: 1. the channel row, 2. the server-name lookup.
    const db = createSequentialDb([
      [{ id: "ch_1", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ name: "studio" }],
    ]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { channelId: "ch_1" }, "bot_1");
    expect(result).toBe("ch_1");
  });

  it("channel scope: null when the channel row is gone", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { channelId: "ch_gone" }, "bot_1");
    expect(result).toBeNull();
  });

  it("thread scope: returns the thread channel id when parent + root + server resolve", async () => {
    // Call order: 1. thread channel row, 2+3. parent-channel + root-message
    // (Promise.all), 4. server-name lookup.
    const db = createSequentialDb([
      [{ id: "thread_1", serverId: "srv_1", parentChannelId: "ch_parent", parentMessageId: "m_root" }],
      [{ serverId: "srv_1" }],
      [{ seq: 7 }],
      [{ name: "studio" }],
    ]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { channelId: "thread_1" }, "bot_1");
    expect(result).toBe("thread_1");
  });

  it("DM scope: returns the dm conversation id when the dm + peer resolve", async () => {
    // Call order: 1. the dm-conversation row, 2. the peer lookup.
    const db = createSequentialDb([
      [{ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1" }],
      [{ id: "peer_1" }],
    ]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { dmConversationId: "dm_1" }, "bot_1");
    expect(result).toBe("dm_1");
  });

  it("DM scope: null when the dm conversation itself doesn't resolve", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { dmConversationId: "dm_gone" }, "bot_1");
    expect(result).toBeNull();
  });

  it("DM scope: null (never a placeholder) when the peer no longer resolves", async () => {
    const db = createSequentialDb([
      [{ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1" }],
      [], // peer row missing (e.g. hard-deleted)
    ]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { dmConversationId: "dm_1" }, "bot_1");
    expect(result).toBeNull();
  });
});

describe("listMessagesBySeq", () => {
  it("default (no cursor): fetches latest page desc then reverses to ascending", async () => {
    const db = createSequentialDb([
      [rawMsg({ id: "m_3", seq: 3 }), rawMsg({ id: "m_2", seq: 2 }), rawMsg({ id: "m_1", seq: 1 })],
    ]);
    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { limit: 50 });
    expect(result.items.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(result.hasMore).toBe(false);
    expect(result.latestSeq).toBe(3);
  });

  it("after cursor: ascending order, trims the probe row and reports hasMore", async () => {
    // limit=2 → fetches limit+1=3 rows to probe for more.
    const db = createSequentialDb([
      [rawMsg({ id: "m_2", seq: 2 }), rawMsg({ id: "m_3", seq: 3 }), rawMsg({ id: "m_4", seq: 4 })],
    ]);
    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { after: 1, limit: 2 });
    expect(result.items.map((m) => m.seq)).toEqual([2, 3]);
    expect(result.hasMore).toBe(true);
    expect(result.latestSeq).toBe(3);
  });

  it("before cursor: fetched desc, reversed to ascending, probe row trimmed off the OLD end", async () => {
    const db = createSequentialDb([
      [rawMsg({ id: "m_9", seq: 9 }), rawMsg({ id: "m_8", seq: 8 }), rawMsg({ id: "m_7", seq: 7 })],
    ]);
    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { before: 10, limit: 2 });
    expect(result.items.map((m) => m.seq)).toEqual([8, 9]);
    expect(result.hasMore).toBe(true);
  });

  it("around cursor: merges before/at/after into one ascending window", async () => {
    // 3 selects: at (exact match), before (desc, reversed), after (asc).
    const db = createSequentialDb([
      [rawMsg({ id: "m_5", seq: 5 })],
      [rawMsg({ id: "m_4", seq: 4 })],
      [rawMsg({ id: "m_6", seq: 6 })],
    ]);
    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { around: 5, limit: 10 });
    expect(result.items.map((m) => m.seq)).toEqual([4, 5, 6]);
  });

  it("around cursor: probes both sides for hasMore and trims back to limit", async () => {
    const db = createSequentialDb([
      [rawMsg({ id: "m_5", seq: 5 })],
      [rawMsg({ id: "m_4", seq: 4 }), rawMsg({ id: "m_3", seq: 3 })],
      [rawMsg({ id: "m_6", seq: 6 }), rawMsg({ id: "m_7", seq: 7 })],
    ]);

    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { around: 5, limit: 3 });

    expect(result.items.map((m) => m.seq)).toEqual([4, 5, 6]);
    expect(result.hasMore).toBe(true);
    expect(result.latestSeq).toBe(6);
  });

  it("around cursor: excludes legacy seq 0 from the anchor query", async () => {
    const db = createSequentialDb([
      [], // at seq 0 is intentionally filtered out by excludeSentinel
      [],
      [rawMsg({ id: "m_1", seq: 1 })],
    ]);

    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { around: 0, limit: 10 });

    expect(result.items.map((m) => m.seq)).toEqual([1]);
    expect(result.hasMore).toBe(false);
  });

  it("returns latestSeq undefined for an empty page", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.listMessagesBySeq(db, { channelId: "ch_empty" }, {});
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.latestSeq).toBeUndefined();
  });

  it("caps limit at 200 even when a larger value is requested", async () => {
    const db = createSequentialDb([[]]);
    await agentInbox.listMessagesBySeq(db, { channelId: "ch_1" }, { limit: 9999 });
    const chainResult = db.select.mock.results[0]!.value;
    expect(chainResult.limit).toHaveBeenCalledWith(201);
  });
});
