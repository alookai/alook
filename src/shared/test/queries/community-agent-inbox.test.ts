import { describe, it, expect, vi } from "vitest";
import * as agentInbox from "../../src/db/queries/community/agent-inbox";
import { formatRef, formatSeq, DM_SERVER } from "../../src/community-cli-contract";

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

describe("toAgentMessages", () => {
  it("returns [] and never touches the db for an empty row list", async () => {
    const db = createSequentialDb([]);
    const result = await agentInbox.toAgentMessages(db, [], "viewer_1");
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("hydrates a plain channel message: ref, sender, content, seq, time", async () => {
    // Call order (all non-empty-guarded selects, in construction order):
    //  1. resolveScopeRefs' `channels` query (channelIds=[ch_1])
    //  2. toAgentMessages' own author-name query (outer Promise.all's 2nd slot)
    //  3. resolveScopeRefs' `servers` query (serverIds=[srv_1]; parentChannelIds/
    //     parentMessageIds/dmIds are all empty here, so those selects — including
    //     the DM-peer lookup — are skipped)
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(db, [rawMsg()], "viewer_1");
    expect(msg).toEqual({
      seq: formatSeq(1),
      channel: formatRef({ server: "studio", channel: "general" }),
      sender: "@Alice#1234",
      content: { text: "hello" },
      time: "2026-07-01T00:00:00.000Z",
    });
  });

  it("hydrates a thread message with the thread-form ref (/server/parent/#rootSeq)", async () => {
    // Call order: 1. channels (thread channel itself), 2. author names,
    // 3. parentChannels, 4. servers, 5. parentMessages (root seq lookup).
    // dmIds empty throughout → dm query + dmPeer users query both skipped.
    const db = createSequentialDb([
      [{ id: "thread_1", name: "thread-x", serverId: "srv_1", parentChannelId: "ch_parent", parentMessageId: "m_root" }],
      [{ id: "u_1", name: "Alice" }],
      [{ id: "ch_parent", name: "general" }],
      [{ id: "srv_1", name: "studio" }],
      [{ id: "m_root", seq: 7 }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ channelId: "thread_1" })],
      "viewer_1"
    );
    expect(msg!.channel).toBe(formatRef({ server: "studio", channel: "general", threadRootSeq: 7 }));
  });

  it("hydrates a DM message, addressing the OTHER party (as a name#0042 handle) relative to viewerId", async () => {
    // Call order: 1. dms query (channels query skipped, channelIds empty),
    // 2. author names (outer Promise.all's 2nd slot — evaluated synchronously
    // right after resolveScopeRefs' own internal await yields), 3. the DM-peer
    // name+discriminator lookup (resolveScopeRefs, after its first internal
    // Promise.all resolves — parentChannels/servers/parentMessages stay
    // skipped, no channel scopes at all).
    const db = createSequentialDb([
      [{ id: "dm_1", user1Id: "viewer_1", user2Id: "peer_1" }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "peer_1", name: "Bob", discriminator: "9999" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ channelId: null, dmConversationId: "dm_1" })],
      "viewer_1"
    );
    expect(msg!.channel).toBe(formatRef({ server: DM_SERVER, channel: "Bob#9999" }));
  });

  it("falls back to /unknown/<key> when the scope can't be resolved (e.g. deleted channel)", async () => {
    const db = createSequentialDb([
      [], // channels query returns nothing for a stale/deleted channelId
      [{ id: "u_1", name: "Alice" }],
      [], // serverIds ends up empty since no channel row was found
    ]);
    const [msg] = await agentInbox.toAgentMessages(db, [rawMsg({ channelId: "ch_gone" })], "viewer_1");
    expect(msg!.channel).toBe("/unknown/ch_gone");
  });

  it("falls back to the raw authorId as sender when the user row is missing", async () => {
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [], // author lookup misses
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(db, [rawMsg({ authorId: "u_ghost" })], "viewer_1");
    expect(msg!.sender).toBe("@u_ghost");
  });
});

describe("toAgentMessage", () => {
  it("returns the single hydrated message (convenience wrapper)", async () => {
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const msg = await agentInbox.toAgentMessage(db, rawMsg(), "viewer_1");
    expect(msg.sender).toBe("@Alice#1234");
  });
});

describe("listUnreadMessagesForAgent", () => {
  it("strips the internal lastReadSeq column before returning rows", async () => {
    const db = createSequentialDb([
      [{ ...rawMsg(), lastReadSeq: 0 }],
    ]);
    const result = await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });
    expect(result).toEqual([rawMsg()]);
    expect(result[0]).not.toHaveProperty("lastReadSeq");
  });

  it("passes opts.max through to .limit()", async () => {
    const db = createSequentialDb([[]]);
    await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 17 });
    // The final chain instance's `.limit` mock recorded the call.
    const chainResult = db.select.mock.results[0]!.value;
    expect(chainResult.limit).toHaveBeenCalledWith(17);
  });

  it("joins scope tables before unread filtering", async () => {
    const db = createSequentialDb([[]]);
    await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });

    const chainResult = db.select.mock.results[0]!.value;
    expect(chainResult.leftJoin).toHaveBeenCalledTimes(4);
    expect(chainResult.leftJoin.mock.invocationCallOrder[0]).toBeLessThan(
      chainResult.where.mock.invocationCallOrder[0]
    );
  });
});

describe("getLatestUnreadMessageForAgent", () => {
  it("returns null when there's no unread anywhere", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    expect(result).toBeNull();
  });

  it("returns the single most-recent unread message id, ordered by createdAt desc limit 1", async () => {
    // The mock DB only records the LAST call to each chain method, so this
    // exercises the id extraction — the createdAt-desc/limit-1 ordering
    // itself is asserted via the `.orderBy`/`.limit` call-args check below.
    const db = createSequentialDb([[{ id: "m_latest" }]]);
    const result = await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    expect(result).toEqual({ messageId: "m_latest" });
  });

  it("orders by createdAt desc and limits to 1 (comparable across channel + DM scopes, unlike seq)", async () => {
    const db = createSequentialDb([[]]);
    await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    const chainResult = db.select.mock.results[0]!.value;
    expect(chainResult.orderBy).toHaveBeenCalledTimes(1);
    expect(chainResult.limit).toHaveBeenCalledWith(1);
  });

  it("joins scope tables before unread filtering (same predicates as listUnreadMessagesForAgent)", async () => {
    const db = createSequentialDb([[]]);
    await agentInbox.getLatestUnreadMessageForAgent(db, "bot_1");
    const chainResult = db.select.mock.results[0]!.value;
    expect(chainResult.leftJoin).toHaveBeenCalledTimes(4);
    expect(chainResult.leftJoin.mock.invocationCallOrder[0]).toBeLessThan(
      chainResult.where.mock.invocationCallOrder[0]
    );
  });
});

describe("resolveUnreadNoticeChannel", () => {
  it("DM scope: produces a handle-based ref (/.dm/name#0042), not a raw peerId", async () => {
    // Call order: 1. the dm-conversation row, 2. the peer's name+discriminator.
    const db = createSequentialDb([
      [{ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1" }],
      [{ name: "Bob", discriminator: "9999" }],
    ]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { dmConversationId: "dm_1" }, "bot_1");
    expect(result).toBe(formatRef({ server: DM_SERVER, channel: "Bob#9999" }));
  });

  it("DM scope: null when the dm conversation itself doesn't resolve", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { dmConversationId: "dm_gone" }, "bot_1");
    expect(result).toBeNull();
  });

  it("DM scope: null (never a bare-peerId placeholder) when the peer no longer resolves to a name+discriminator", async () => {
    const db = createSequentialDb([
      [{ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1" }],
      [], // peer row missing (e.g. hard-deleted)
    ]);
    const result = await agentInbox.resolveUnreadNoticeChannel(db, { dmConversationId: "dm_1" }, "bot_1");
    expect(result).toBeNull();
  });
});

describe("getInboxSnapshotForAgent", () => {
  it("returns [] and skips the user-name lookup when there's no pending unread", async () => {
    const db = createSequentialDb([[]]);
    const result = await agentInbox.getInboxSnapshotForAgent(db, "bot_1");
    expect(result).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("hydrates latestSender from the user table and sets hasMention from mentionCount", async () => {
    const db = createSequentialDb([
      [
        {
          channelId: "ch_1",
          dmConversationId: null,
          pendingCount: 3,
          firstPendingSeq: 5,
          latestSeq: 7,
          latestSenderId: "u_1",
          mentionCount: 1,
        },
        {
          channelId: "ch_2",
          dmConversationId: null,
          pendingCount: 1,
          firstPendingSeq: 9,
          latestSeq: 9,
          latestSenderId: "u_2",
          mentionCount: 0,
        },
      ],
      [
        { id: "u_1", name: "Alice", discriminator: "1234" },
        { id: "u_2", name: "Bob", discriminator: "5678" },
      ],
    ]);
    const result = await agentInbox.getInboxSnapshotForAgent(db, "bot_1");
    expect(result).toEqual([
      {
        channelId: "ch_1",
        dmConversationId: null,
        pendingCount: 3,
        firstPendingSeq: 5,
        latestSeq: 7,
        latestSender: "@Alice#1234",
        hasMention: true,
      },
      {
        channelId: "ch_2",
        dmConversationId: null,
        pendingCount: 1,
        firstPendingSeq: 9,
        latestSeq: 9,
        latestSender: "@Bob#5678",
        hasMention: false,
      },
    ]);
  });

  it("joins scope tables before unread aggregation", async () => {
    const db = createSequentialDb([[]]);
    await agentInbox.getInboxSnapshotForAgent(db, "bot_1");

    const chainResult = db.select.mock.results[0]!.value;
    expect(chainResult.leftJoin).toHaveBeenCalledTimes(4);
    expect(chainResult.leftJoin.mock.invocationCallOrder[0]).toBeLessThan(
      chainResult.where.mock.invocationCallOrder[0]
    );
  });
});

describe("toInboxRows", () => {
  it("returns [] and never touches the db for an empty row list", async () => {
    const db = createSequentialDb([]);
    const result = await agentInbox.toInboxRows(db, [], "viewer_1");
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("sets dm/thread/mention flags based on the row shape", async () => {
    // Row 1: a DM row with a mention. Row 2: a thread-channel row, no mention.
    const rows: agentInbox.InboxSnapshotRow[] = [
      {
        channelId: null,
        dmConversationId: "dm_1",
        pendingCount: 2,
        firstPendingSeq: 1,
        latestSeq: 2,
        latestSender: "@Bob",
        hasMention: true,
      },
      {
        channelId: "thread_1",
        dmConversationId: null,
        pendingCount: 1,
        firstPendingSeq: 10,
        latestSeq: 10,
        latestSender: "@Alice",
        hasMention: false,
      },
    ];
    // Call order: 1. channels query (channelIds=[thread_1]), 2. dms query
    // (dmIds=[dm_1]), 3. DM-peer name+discriminator lookup (dmPeerIds=[peer_1],
    // awaited right after the first internal Promise.all resolves — NOT part
    // of that Promise.all itself), 4. parentChannels, 5. servers, 6. parentMessages.
    const db = createSequentialDb([
      [{ id: "thread_1", name: "thread-x", serverId: "srv_1", parentChannelId: "ch_parent", parentMessageId: "m_root" }],
      [{ id: "dm_1", user1Id: "viewer_1", user2Id: "peer_1" }],
      [{ id: "peer_1", name: "Bob", discriminator: "9999" }],
      [{ id: "ch_parent", name: "general" }],
      [{ id: "srv_1", name: "studio" }],
      [{ id: "m_root", seq: 3 }],
    ]);
    const result = await agentInbox.toInboxRows(db, rows, "viewer_1");
    expect(result[0]).toMatchObject({
      channel: formatRef({ server: DM_SERVER, channel: "Bob#9999" }),
      flags: ["dm", "mention"],
    });
    expect(result[1]).toMatchObject({
      channel: formatRef({ server: "studio", channel: "general", threadRootSeq: 3 }),
      flags: ["thread"],
    });
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
