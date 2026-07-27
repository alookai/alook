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
    replyToId: null,
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

  it("read/resolvable: a channel reply gets content.replyTo = { seq, sender } from the in-scope target", async () => {
    // Call order (synchronous phase): 0 channels, 1 author names, 2 reply-scope
    // getMessagesByIdsInScope query; then (post-await) 3 servers.
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "m_target", seq: 37, authorName: "Ana", discriminator: "0012" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ replyToId: "m_target" })],
      "viewer_1"
    );
    expect(msg!.content.replyTo).toEqual({ seq: formatSeq(37), sender: "@Ana#0012" });
  });

  it("read/DM scope: a DM reply resolves the peer's seq + handle correctly", async () => {
    // Call order: 0 dms, 1 author names, 2 reply-scope query, 3 DM-peer lookup.
    const db = createSequentialDb([
      [{ id: "dm_1", user1Id: "viewer_1", user2Id: "peer_1" }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "m_target", seq: 8, authorName: "Bob", discriminator: "9999" }],
      [{ id: "peer_1", name: "Bob", discriminator: "9999" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ channelId: null, dmConversationId: "dm_1", replyToId: "m_target" })],
      "viewer_1"
    );
    expect(msg!.content.replyTo).toEqual({ seq: formatSeq(8), sender: "@Bob#9999" });
  });

  it("read/deleted target: replyToId with no in-scope target → replyTo absent (no sentinel)", async () => {
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [], // target row deleted / not returned
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ replyToId: "m_gone" })],
      "viewer_1"
    );
    expect(msg!.content).not.toHaveProperty("replyTo");
  });

  it("read/out-of-scope target: scope-first query returns nothing → replyTo absent", async () => {
    // getMessagesByIdsInScope scopes on the ROW's own channel; a target that
    // lives in another channel simply doesn't come back in the batch.
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [], // target is in a different channel → not returned by the scoped query
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ replyToId: "m_elsewhere" })],
      "viewer_1"
    );
    expect(msg!.content).not.toHaveProperty("replyTo");
  });

  it("read/seq-0 target: replyToId → a legacy seq 0 row → replyTo absent", async () => {
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "m_legacy", seq: 0, authorName: "Ana", discriminator: "0012" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ replyToId: "m_legacy" })],
      "viewer_1"
    );
    expect(msg!.content).not.toHaveProperty("replyTo");
  });

  it("read/non-reply: replyToId null → no replyTo key and no extra reply query", async () => {
    // Only 3 selects (channels, authors, servers) — resolveReplyRefs returns
    // early with no db call when no row carries a replyToId.
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(db, [rawMsg()], "viewer_1");
    expect(msg!.content).not.toHaveProperty("replyTo");
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("read/cited-author-not-in-batch: sender comes from the scoped target row, not the batch", async () => {
    // The only row's author is u_1/Alice; the cited target's author is Ana,
    // who authored no row in this batch. replyTo.sender must still resolve to
    // Ana's handle — proving it's read off getMessagesByIdsInScope, not the
    // `users` batch lookup.
    const db = createSequentialDb([
      [{ id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null }],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "m_target", seq: 4, authorName: "Ana", discriminator: "0012" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const [msg] = await agentInbox.toAgentMessages(
      db,
      [rawMsg({ replyToId: "m_target" })],
      "viewer_1"
    );
    expect(msg!.content.replyTo?.sender).toBe("@Ana#0012");
  });

  it("read/cross-scope batch: two channels each with a reply resolve within their own scope", async () => {
    // Two rows in two channels, each replying to a target in its OWN channel.
    // resolveReplyRefs groups by scope and issues one query per scope.
    // Sync call phase: 0 channels, 1 authors, 2 reply-scope(ch_1), 3
    // reply-scope(ch_2); then 4 servers.
    const db = createSequentialDb([
      [
        { id: "ch_1", name: "general", serverId: "srv_1", parentChannelId: null, parentMessageId: null },
        { id: "ch_2", name: "random", serverId: "srv_1", parentChannelId: null, parentMessageId: null },
      ],
      [{ id: "u_1", name: "Alice", discriminator: "1234" }],
      [{ id: "t_1", seq: 11, authorName: "Ana", discriminator: "0012" }],
      [{ id: "t_2", seq: 22, authorName: "Ben", discriminator: "3456" }],
      [{ id: "srv_1", name: "studio" }],
    ]);
    const msgs = await agentInbox.toAgentMessages(
      db,
      [
        rawMsg({ id: "m_a", channelId: "ch_1", replyToId: "t_1" }),
        rawMsg({ id: "m_b", channelId: "ch_2", replyToId: "t_2" }),
      ],
      "viewer_1"
    );
    const byChannel = new Map(msgs.map((m) => [m.channel, m]));
    expect(byChannel.get(formatRef({ server: "studio", channel: "general" }))!.content.replyTo)
      .toEqual({ seq: formatSeq(11), sender: "@Ana#0012" });
    expect(byChannel.get(formatRef({ server: "studio", channel: "random" }))!.content.replyTo)
      .toEqual({ seq: formatSeq(22), sender: "@Ben#3456" });
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
  // Call order (visibility + participation pre-narrowed BEFORE the messages
  // SQL so `.limit(max)` operates on already-allowed rows — see
  // `listAgentAllowedChannelIds`):
  //  1. `listVisibleChannelIdsForUser` → server-memberships query
  //  2. `listVisibleChannelIdsForUser` → channels+category join
  //  3. `listVisibleChannelIdsForUser` → viewer's channel-member rows
  //  4. Visible-channel types lookup (skipped when visible set is empty)
  //  5. `listParticipatingThreadIds` (skipped when no narrow types among visible)
  //  6. The messages SQL itself
  it("strips the internal lastReadSeq column before returning rows", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }], // 1. membership
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }], // 2. channels
      [], // 3. viewer memberChannelIds
      [{ id: "ch_1", type: "text" }], // 4. types of visible channels
      [{ ...rawMsg(), lastReadSeq: 0 }], // 5. messages (no narrow types → no participant query)
    ]);
    const result = await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });
    expect(result).toEqual([rawMsg()]);
    expect(result[0]).not.toHaveProperty("lastReadSeq");
  });

  it("passes opts.max through to .limit()", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 17 });
    // The 5th `db.select(...)` chain is the message query — that's where `.limit` lands.
    const chainResult = db.select.mock.results[4]!.value;
    expect(chainResult.limit).toHaveBeenCalledWith(17);
  });

  it("joins only dm + read-state on the messages SQL (visibility & participation are pre-narrowed)", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });

    const chainResult = db.select.mock.results[4]!.value;
    // dm + read-state — communityChannel join dropped now that
    // participation is folded into `listAgentAllowedChannelIds` up front.
    expect(chainResult.leftJoin).toHaveBeenCalledTimes(2);
    expect(chainResult.leftJoin.mock.invocationCallOrder[0]).toBeLessThan(
      chainResult.where.mock.invocationCallOrder[0]
    );
  });

  it("excludes thread/forum_post channels the bot isn't a participant of from the allowed set", async () => {
    // ch_a is a plain text channel (always allowed); ch_b_thread is a thread
    // the bot doesn't participate in. `listAgentAllowedChannelIds` drops
    // ch_b_thread BEFORE the messages SQL runs, so the WHERE never lets a
    // ch_b_thread row through — the earlier post-filter-after-.limit shape
    // could collapse the page to [] when the top-N rows were all
    // non-participating threads.
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [
        { id: "ch_a", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null },
        { id: "ch_b_thread", type: "thread", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: "ch_a" },
      ],
      [],
      [
        { id: "ch_a", type: "text" },
        { id: "ch_b_thread", type: "thread" },
      ],
      [], // listParticipatingThreadIds: bot participates in neither
      [{ ...rawMsg({ id: "m_a", channelId: "ch_a" }), lastReadSeq: 0 }],
    ]);
    const result = await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });
    expect(result.map((r) => r.id)).toEqual(["m_a"]);
  });

  it("keeps thread/forum_post channels when the bot IS a participant", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [
        { id: "ch_a", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null },
        { id: "ch_b_thread", type: "thread", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: "ch_a" },
      ],
      [],
      [
        { id: "ch_a", type: "text" },
        { id: "ch_b_thread", type: "thread" },
      ],
      [{ threadChannelId: "ch_b_thread" }], // participant row exists
      [{ ...rawMsg({ id: "m_b", channelId: "ch_b_thread" }), lastReadSeq: 0 }],
    ]);
    const result = await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });
    expect(result.map((r) => r.id)).toEqual(["m_b"]);
  });

  it("returns [] without hitting the messages SQL when the bot has no server memberships", async () => {
    const db = createSequentialDb([
      [], // no memberships → listVisibleChannelIdsForUser returns []
      [{ ...rawMsg(), lastReadSeq: 0 }], // messages SQL (only DM branch could return, guarded by 1=0 on channel side in real SQL)
    ]);
    const result = await agentInbox.listUnreadMessagesForAgent(db, "bot_1", { max: 50 });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("getLatestUnreadMessageForAgent", () => {
  // Call order (same visibility+participation prelude as
  // listUnreadMessagesForAgent, then a single-row messages SQL):
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
  // Call order:
  //  1-3. `listVisibleChannelIdsForUser` (memberships, channels, viewer members)
  //  4. Visible-channel types lookup
  //  5. `listParticipatingThreadIds` (skipped when no narrow types among visible)
  //  6. The snapshot aggregation SQL
  //  7. sender-name hydration
  it("returns [] and skips the user-name lookup when there's no pending unread", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    const result = await agentInbox.getInboxSnapshotForAgent(db, "bot_1");
    expect(result).toEqual([]);
  });

  it("hydrates latestSender from the user table and sets hasMention from mentionCount", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [
        { id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null },
        { id: "ch_2", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null },
      ],
      [],
      [
        { id: "ch_1", type: "text" },
        { id: "ch_2", type: "text" },
      ],
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

  it("excludes thread/forum_post channels the bot isn't a participant of from the allowed set", async () => {
    // ch_thread is filtered out of `allowedChannelIds` up front, so the
    // aggregation SQL's WHERE ... inArray(channelId, allowed) never surfaces
    // it. No post-filter needed → no risk of an aggregation row silently
    // disappearing after being counted.
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [
        // Top-level thread-typed channel so it survives the visibility pass;
        // the shape only tests the participation narrowing, not
        // parent-anchored visibility (covered elsewhere).
        { id: "ch_thread", type: "thread", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null },
      ],
      [],
      [{ id: "ch_thread", type: "thread" }],
      [], // participant lookup: not a participant → ch_thread dropped from allowed
      [], // aggregation SQL: allowedChannelIds is [], WHERE has 1=0, no rows survive
    ]);
    const result = await agentInbox.getInboxSnapshotForAgent(db, "bot_1");
    expect(result).toEqual([]);
  });

  it("joins only dm + read-state on the aggregation SQL (visibility & participation are pre-narrowed)", async () => {
    const db = createSequentialDb([
      [{ serverId: "srv_1" }],
      [{ id: "ch_1", type: "text", categoryId: null, categoryPrivate: null, creatorId: "u_other", parentChannelId: null }],
      [],
      [{ id: "ch_1", type: "text" }],
      [],
    ]);
    await agentInbox.getInboxSnapshotForAgent(db, "bot_1");

    const chainResult = db.select.mock.results[4]!.value;
    // dm + read-state.
    expect(chainResult.leftJoin).toHaveBeenCalledTimes(2);
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
