import { eq, and, asc, desc, gt, lt, or, sql, inArray, isNotNull } from "drizzle-orm";
import {
  communityMessage,
  communityChannel,
  communityReadState,
  communityMessageSeq,
  communityChannelMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { createLogger } from "../../../logger";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";

/**
 * Atomically claim the next seq value for a channel. A single top-level UPSERT
 * — D1's single-writer serialization makes this race-free for uniqueness on
 * its own, no CTE/transaction needed (see plans/community-agent-cli-bridge.md
 * design §3 for why the CTE-fusion approach is not valid SQLite and was
 * rejected).
 *
 * Unconditional claim: always advances the counter, no matter what the
 * caller's stale view of the world was. Callers with an `expectedSeq` to
 * verify against (the agent-send race, plans/fix-agent-send-race-condition.md)
 * must use the CAS sibling `claimNextSeqIfAligned` below instead — this
 * function alone cannot detect a stale-snapshot race, only guarantee
 * uniqueness.
 */
async function claimNextSeq(db: Database, channelId: string): Promise<number> {
  const rows = await db
    .insert(communityMessageSeq)
    .values({ channelId, nextSeq: 1 })
    .onConflictDoUpdate({
      target: communityMessageSeq.channelId,
      set: { nextSeq: sql`${communityMessageSeq.nextSeq} + 1` },
    })
    .returning({ nextSeq: communityMessageSeq.nextSeq });
  return rows[0]!.nextSeq;
}

/**
 * Compare-and-swap claim: only advances `next_seq` if it currently equals
 * `expectedSeq` — the value the caller observed during its own alignment
 * check. Returns the newly claimed seq on success, or `null` if another
 * writer already advanced the counter (the caller lost the race and MUST
 * treat this as a no-op: no message row, no side effects of any kind).
 *
 * Safe for the very first message in a scope too: when no row exists yet,
 * the INSERT branch fires unconditionally (no conflict to gate), but that
 * branch can only ever be reached by the single first-ever writer for that
 * scope_key — every subsequent racer hits the conflict branch and is
 * correctly gated by `setWhere`.
 */
async function claimNextSeqIfAligned(
  db: Database,
  channelId: string,
  expectedSeq: number
): Promise<number | null> {
  const rows = await db
    .insert(communityMessageSeq)
    .values({ channelId, nextSeq: 1 })
    .onConflictDoUpdate({
      target: communityMessageSeq.channelId,
      set: { nextSeq: sql`${communityMessageSeq.nextSeq} + 1` },
      setWhere: sql`${communityMessageSeq.nextSeq} = ${expectedSeq}`,
    })
    .returning({ nextSeq: communityMessageSeq.nextSeq });
  return rows[0]?.nextSeq ?? null;
}

const DEFAULT_LIMIT = 50;

// Module-level logger so every parse failure lands on the same service tag.
// Shared with any consumer of these queries; the alternative (plumbing a
// logger down through 30+ call sites) buys nothing here.
const log = createLogger({ service: "community-queries" });

// TEXT column at rest → JSON at the boundary. Isolating the parse here keeps
// storage-format concerns out of every route.
function safeParseEmbeds(raw: string | null, messageId: string): unknown | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn("embeds_parse_failed", { messageId, err });
    return undefined;
  }
}

export type CreateMessageData = {
  id?: string;
  authorId: string;
  content: string;
  channelId: string;
  type?: string;
  mentionType?: string;
  replyToId?: string;
  embeds?: string;
  /** Back-reference stamped on friend-approval DM card messages only. */
  friendshipId?: string;
  /**
   * Client-supplied idempotency key. When present it is persisted so a resend
   * carrying the same nonce dedupes on (author_id, client_nonce). NULL/absent =
   * today's behavior (never deduped). See mutation-idempotency plan.
   */
  clientNonce?: string;
  /**
   * Extra Drizzle statements to commit in the SAME atomic batch as the message
   * insert (zero new round-trip). The bot-send routes use this to bump the
   * per-day sent activity rollup for the heatmap; human sends pass nothing. The
   * statements run only if the message row is written (they share the batch's
   * all-or-nothing fate — and if the CAS seq claim above loses, the batch never
   * runs, so a lost race correctly skips them). This function stays
   * identity-agnostic: the CALLER decides what to append, not `createMessage`.
   */
  extraStatements?: unknown[];
};

/**
 * `createMessage` overloads (plans/fix-agent-send-race-condition.md design §2):
 * callers that never pass `expectedSeq` keep today's non-nullable return
 * type — no pointless null-checks forced onto direct callers such as message
 * send, bot provisioning, and friend request, which never opt into the CAS
 * guard. Only
 * callers that explicitly pass a numeric `expectedSeq` (the agent-send race
 * fix) see the nullable return — `null` means "lost the race, no row was
 * written, treat as a complete no-op".
 */
export async function createMessage(
  db: Database,
  data: CreateMessageData & { expectedSeq?: undefined }
): Promise<Awaited<ReturnType<typeof insertMessageRow>>>;
export async function createMessage(
  db: Database,
  data: CreateMessageData & { expectedSeq: number }
): Promise<Awaited<ReturnType<typeof insertMessageRow>> | null>;
export async function createMessage(
  db: Database,
  data: CreateMessageData & { expectedSeq?: number }
) {
  // Step 0: atomically claim this scope's next seq (own top-level statement —
  // see design §3 for why this can't be fused into the INSERT below via a
  // CTE). Accepted trade-off: if the INSERT below fails after this succeeds,
  // the counter has a harmless gap — no duplicate seq is ever possible since
  // this claim is independently atomic under D1's single-writer serialization.
  // Do NOT wrap these two statements in a transaction to "fix" this — D1
  // doesn't support one that could express it. Kept outside the batch below
  // because D1 `batch()` cannot feed one statement's `.returning()` into a
  // later statement's values.
  //
  // When `expectedSeq` is present (plans/fix-agent-send-race-condition.md),
  // the claim is a compare-and-swap gated on the caller's own alignment-check
  // snapshot: `claimNextSeqIfAligned` returns `null` with ZERO rows written
  // anywhere if another writer already advanced the counter past what this
  // caller saw — return `null` immediately, before any insert/update below.
  const seq =
    data.expectedSeq !== undefined
      ? await claimNextSeqIfAligned(db, data.channelId, data.expectedSeq)
      : await claimNextSeq(db, data.channelId);
  if (seq === null) return null;
  return insertMessageRow(db, data, seq);
}

// Step 1+: everything after the seq claim above — message insert,
// channel/DM `lastMessageAt` bump, author read-state watermark. Split out of
// `createMessage` purely so the two overload signatures above can reference
// its return type instead of duplicating a hand-written row type; behavior
// is identical to having this inlined.
async function insertMessageRow(db: Database, data: CreateMessageData, seq: number) {
  const now = new Date().toISOString();

  // Pass `createdAt: now` explicitly so `msg.createdAt` matches the exact
  // string we write to `channel.lastMessageAt` and to the author's read-state
  // watermark below. Without this, the schema `$defaultFn` fires a microsecond
  // later and the timestamps diverge — the inbox predicate
  // `lastMessageAt > lastReadAt` would then wrongly fire for the author's own
  // send on a cold read.
  const insertMsg = db
    .insert(communityMessage)
    .values({
      // Drizzle's `$defaultFn` on `communityMessage.id` only fires when the
      // field is absent from `.values(...)`; passing `id` explicitly when the
      // caller supplies one keeps the pre-minted path a one-line difference.
      ...(data.id !== undefined ? { id: data.id } : {}),
      authorId: data.authorId,
      content: data.content,
      channelId: data.channelId,
      type: data.type ?? "default",
      mentionType: data.mentionType ?? null,
      replyToId: data.replyToId ?? null,
      embeds: data.embeds ?? null,
      friendshipId: data.friendshipId ?? null,
      clientNonce: data.clientNonce ?? null,
      createdAt: now,
      seq,
    })
    .returning();

  // Message insert + channel counter/timestamp bump commit atomically via
  // `db.batch(...)`. DMs are channels now, so this is always a channel update.
  const scopeUpdate = db
    .update(communityChannel)
    .set({
      lastMessageAt: now,
      messageCount: sql`${communityChannel.messageCount} + 1`,
    })
    .where(eq(communityChannel.id, data.channelId));

  type InsertedMessage = Awaited<typeof insertMsg>[number];
  // Caller-supplied extra statements (e.g. the bot sent-activity rollup bump)
  // ride this same batch — appended AFTER insert+scope so the message row is
  // index 0. They share the batch's all-or-nothing commit.
  const batchStatements = [insertMsg, scopeUpdate, ...(data.extraStatements ?? [])];
  const results = (await db.batch(batchStatements as any)) as any[];
  const msg = (results[0] as InsertedMessage[])[0]!;

  // Author read-watermark: advance the sender's own read-state to this
  // message so `listUnreadChannels` (predicate: lastMessageAt > lastReadAt)
  // never surfaces the channel the author just sent in. Kept inline (NOT
  // folded into `markReadToMessageBuilder`, which is deliberately "humans
  // only" — see its comment) because this path must write `lastReadSeq` per
  // design §4 — every author (bot or human) must have its own `lastReadSeq`
  // stay in lockstep with its sends, or `enqueueBotWakes` sees a stale
  // watermark. Runs as a separate await because it needs `msg.id`.
  await db
    .insert(communityReadState)
    .values({
      userId: data.authorId,
      channelId: data.channelId,
      lastReadAt: now,
      lastReadMessageId: msg.id,
      lastReadSeq: seq,
    })
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.channelId],
      set: { lastReadAt: now, lastReadMessageId: msg.id, lastReadSeq: seq },
      setWhere: sql`${communityReadState.lastReadSeq} < ${seq}`,
    });

  return msg;
}

/**
 * Cascading rollback of a message row. Reserved for compensating a message
 * that was written moments before but a follow-up dependency failed to
 * persist (approval-request, attachment reserve, etc.). Do NOT use for
 * user-facing message deletion — that path should soft-delete / tombstone.
 *
 * Reverts everything `insertMessageRow` wrote:
 *   1. DELETE the message row itself.
 *   2. Channel/DM lastMessageAt (recomputed via `MAX(createdAt)` subquery so
 *      concurrent inserts keep their timestamps) + `messageCount -= 1` on
 *      channel (DM has no counter).
 *   3. Author's `communityReadState` row: if a prior message in scope exists,
 *      revert the watermark to it (guarded by `lastReadMessageId = messageId`
 *      so a concurrent same-author send that already advanced past our seq
 *      keeps its newer state); if this was the first-ever message in scope,
 *      DELETE the read-state row entirely so the schema's
 *      "materialized ⇒ lastReadMessageId IS NOT NULL" invariant holds — the
 *      next send re-inserts through `.onConflictDoUpdate`, and the DELETE
 *      completes inside the same batch so no partial-UNIQUE-index collision.
 *
 * Idempotent — if the message is already gone (double-rollback race), the
 * initial SELECT returns nothing and the whole cascade is skipped.
 */
export async function hardDeleteMessage(db: Database, messageId: string) {
  const msgRows = await db
    .select({
      id: communityMessage.id,
      channelId: communityMessage.channelId,
      authorId: communityMessage.authorId,
      seq: communityMessage.seq,
      createdAt: communityMessage.createdAt,
    })
    .from(communityMessage)
    .where(eq(communityMessage.id, messageId))
    .limit(1);
  const msg = msgRows[0];
  if (!msg) return;

  // Prior-in-scope message for the read-state revert. Pre-fetched because
  // Drizzle's D1 batch driver serializes each statement independently and
  // cannot pipe one statement's result into another. Safe: the read-state
  // UPDATE in the batch is guarded by `lastReadMessageId = messageId`, so a
  // concurrent same-author advance past our seq keeps its own newer state
  // regardless of what this prior lookup returns.
  const scopeMatch = eq(communityMessage.channelId, msg.channelId);
  const priorRows = await db
    .select({
      id: communityMessage.id,
      seq: communityMessage.seq,
      createdAt: communityMessage.createdAt,
    })
    .from(communityMessage)
    .where(and(scopeMatch, lt(communityMessage.seq, msg.seq)))
    .orderBy(desc(communityMessage.seq))
    .limit(1);
  const prior = priorRows[0];

  const deleteMsg = db.delete(communityMessage).where(eq(communityMessage.id, messageId));

  // `lastMessageAt` is an INLINE `MAX(createdAt)` subquery — never pre-fetched.
  // A concurrent writer inserting a newer message between our SELECT above and
  // this UPDATE would otherwise get its timestamp clobbered. Same rule for
  // `messageCount - 1`: a JS-side `oldCount - 1` would clobber any concurrent
  // insert that landed between the pre-batch SELECT and this UPDATE.
  const scopeUpdate = db
    .update(communityChannel)
    .set({
      messageCount: sql`${communityChannel.messageCount} - 1`,
      lastMessageAt: sql<
        string | null
      >`(SELECT MAX(${communityMessage.createdAt}) FROM ${communityMessage} WHERE ${communityMessage.channelId} = ${msg.channelId} AND ${communityMessage.id} != ${messageId})`,
    })
    .where(eq(communityChannel.id, msg.channelId));

  const readStateWhere = and(
    eq(communityReadState.userId, msg.authorId),
    eq(communityReadState.channelId, msg.channelId),
    eq(communityReadState.lastReadMessageId, messageId)
  );

  const readStateStmt = prior
    ? db
        .update(communityReadState)
        .set({
          lastReadMessageId: prior.id,
          lastReadSeq: prior.seq,
          lastReadAt: prior.createdAt,
        })
        .where(readStateWhere)
    : db.delete(communityReadState).where(readStateWhere);

  await db.batch([deleteMsg, scopeUpdate, readStateStmt] as any);
}

// Shared select projection for the three list-messages paths (`listMessages`,
// `listMessagesAround`, `listMessagesSince`). Keeps their row shape identical
// so downstream mappers (`mapMessageForApi`) don't have to branch on source.
const listedMessageProjection = {
  id: communityMessage.id,
  authorId: communityMessage.authorId,
  content: communityMessage.content,
  type: communityMessage.type,
  mentionType: communityMessage.mentionType,
  replyToId: communityMessage.replyToId,
  embeds: communityMessage.embeds,
  seq: communityMessage.seq,
  createdAt: communityMessage.createdAt,
  channelId: communityMessage.channelId,
  friendshipId: communityMessage.friendshipId,
  authorName: user.name,
  authorEmail: user.email,
  authorImage: user.image,
} as const;

export type ListedMessageRow = {
  id: string;
  authorId: string;
  content: string;
  type: string;
  mentionType: string | null;
  replyToId: string | null;
  embeds: unknown | undefined;
  seq: number;
  createdAt: string;
  channelId: string;
  friendshipId: string | null;
  authorName: string;
  authorEmail: string;
  authorImage: string | null;
};

function parseEmbeds(r: { id: string; embeds: string | null } & Record<string, unknown>): ListedMessageRow {
  return { ...(r as unknown as ListedMessageRow), embeds: safeParseEmbeds(r.embeds, r.id) };
}

export async function listMessages(
  db: Database,
  opts: {
    channelId: string;
    cursor?: { createdAt: string; id: string };
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const conditions: ReturnType<typeof eq>[] = [
    eq(communityMessage.channelId, opts.channelId),
  ];

  if (opts.cursor) {
    conditions.push(
      or(
        lt(communityMessage.createdAt, opts.cursor.createdAt),
        and(
          eq(communityMessage.createdAt, opts.cursor.createdAt),
          lt(communityMessage.id, opts.cursor.id)
        )
      )! as ReturnType<typeof eq>
    );
  }

  const rows = await db
    .select(listedMessageProjection)
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions))
    .orderBy(desc(communityMessage.createdAt), desc(communityMessage.id))
    .limit(limit);

  return rows.map(parseEmbeds);
}

/**
 * Windowed page centered on `anchor` — used by the client's "jump to unread"
 * and "jump to reply" flows. Returns the older half (strictly before the
 * anchor, DESC) and the newer half (INCLUSIVE of the anchor, ASC) separately
 * so the caller can encode `hasMoreOlder` / `hasMoreNewer` without re-deriving
 * boundary math. See plans/community-message-scroll-v2.md §A1.
 *
 * The two halves are fetched in parallel (`Promise.all`) — they share no state
 * beyond the anchor tuple. Each half fetches one extra row past the requested
 * window size to detect a "more available" boundary.
 */
export async function listMessagesAround(
  db: Database,
  opts: {
    channelId: string;
    anchor: { createdAt: string; id: string };
    limit?: number;
  }
): Promise<{
  older: ListedMessageRow[];
  newer: ListedMessageRow[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
}> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const olderHalf = Math.ceil(limit / 2);
  const newerHalf = Math.floor(limit / 2);

  const scopeConds: ReturnType<typeof eq>[] = [
    eq(communityMessage.channelId, opts.channelId),
  ];

  // Older half: strictly older than the anchor tuple, DESC. Fetch one extra
  // row to distinguish "exactly N older" from "N older with more available".
  const olderCond = or(
    lt(communityMessage.createdAt, opts.anchor.createdAt),
    and(
      eq(communityMessage.createdAt, opts.anchor.createdAt),
      lt(communityMessage.id, opts.anchor.id)
    )
  )! as ReturnType<typeof eq>;

  // Newer half INCLUDES the anchor (id >= anchor.id at the same createdAt) so
  // the returned window renders the anchor row itself.
  const newerCond = or(
    gt(communityMessage.createdAt, opts.anchor.createdAt),
    and(
      eq(communityMessage.createdAt, opts.anchor.createdAt),
      // gte via (id > anchor.id OR id = anchor.id) — no ORM `gte` combinator on
      // text; expressing it as two comparisons is the shortest Drizzle-only path.
      or(
        gt(communityMessage.id, opts.anchor.id),
        eq(communityMessage.id, opts.anchor.id)
      )!
    )
  )! as ReturnType<typeof eq>;

  const [olderRows, newerRows] = await Promise.all([
    db
      .select(listedMessageProjection)
      .from(communityMessage)
      .innerJoin(user, eq(communityMessage.authorId, user.id))
      .where(and(...scopeConds, olderCond))
      .orderBy(desc(communityMessage.createdAt), desc(communityMessage.id))
      .limit(olderHalf + 1),
    db
      .select(listedMessageProjection)
      .from(communityMessage)
      .innerJoin(user, eq(communityMessage.authorId, user.id))
      .where(and(...scopeConds, newerCond))
      // Anchor + newerHalf newer rows + 1 extra probe.
      .orderBy(asc(communityMessage.createdAt), asc(communityMessage.id))
      .limit(newerHalf + 1 + 1),
  ]);

  const hasMoreOlder = olderRows.length > olderHalf;
  const older = (hasMoreOlder ? olderRows.slice(0, olderHalf) : olderRows).map(parseEmbeds);

  // The newer window's target size is (anchor + newerHalf). Anything beyond
  // means more newer rows exist server-side.
  const newerBudget = newerHalf + 1;
  const hasMoreNewer = newerRows.length > newerBudget;
  const newer = (hasMoreNewer ? newerRows.slice(0, newerBudget) : newerRows).map(parseEmbeds);

  return { older, newer, hasMoreOlder, hasMoreNewer };
}

/**
 * Rows strictly newer than `since`, in chronological ASC order. Used by the
 * client's cache-hydration and WS-reconnect catch-up flows to top-off a stale
 * cache without re-fetching everything. See plans/community-message-scroll-v2.md §A1.
 *
 * Returns `limit + 1` rows when more exist; the caller trims to `limit` and
 * sets `hasMoreNewer`.
 */
export async function listMessagesSince(
  db: Database,
  opts: {
    channelId: string;
    since: { createdAt: string; id: string };
    limit?: number;
  }
): Promise<ListedMessageRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const conditions: ReturnType<typeof eq>[] = [
    eq(communityMessage.channelId, opts.channelId),
  ];

  conditions.push(
    or(
      gt(communityMessage.createdAt, opts.since.createdAt),
      and(
        eq(communityMessage.createdAt, opts.since.createdAt),
        gt(communityMessage.id, opts.since.id)
      )
    )! as ReturnType<typeof eq>
  );

  const rows = await db
    .select(listedMessageProjection)
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions))
    .orderBy(asc(communityMessage.createdAt), asc(communityMessage.id))
    .limit(limit + 1);

  return rows.map(parseEmbeds);
}

/**
 * The largest `seq` value in a channel or DM scope, or `0` for an empty
 * scope. Consumed by the message-list envelope so the client can compute
 * `↓ N` (unread count vs. `latestSeq`) and drive `?since` catch-up without a
 * second round-trip. See plans/community-message-scroll-v2.md §A1.
 */
export async function getLatestMessageSeq(
  db: Database,
  target: { channelId: string }
): Promise<number> {
  // `MAX()` returns NULL when the channel is empty; coalesce to 0 to keep the
  // shape of `latestSeq` scalar rather than optional. No ORM aggregator for
  // MAX in Drizzle — same `sql\`MAX(...)\`` idiom as `getLatestMessagesByChannelIds`.
  const rows = await db
    .select({ maxSeq: sql<number | null>`MAX(${communityMessage.seq})` })
    .from(communityMessage)
    .where(eq(communityMessage.channelId, target.channelId));

  return rows[0]?.maxSeq ?? 0;
}

/**
 * Newest-by-`createdAt` message row for a single channel or DM conversation.
 * Returns `null` when the target has no messages yet.
 *
 * Callers use this to derive the `(id, createdAt)` tuple that
 * `markReadToMessageBuilder` / `markReadToMessage` require. When the target
 * is empty the mass mark-read paths must SKIP the write instead of inserting
 * a `lastReadMessageId = null` row — see the invariant in `read-state.ts`.
 */
export async function getLatestMessage(
  db: Database,
  target: { channelId: string }
): Promise<{ id: string; createdAt: string; seq: number } | null> {
  const rows = await db
    .select({
      id: communityMessage.id,
      createdAt: communityMessage.createdAt,
      // `seq` so the human read-state writers can store `lastReadSeq` alongside
      // `lastReadAt`/`lastReadMessageId` (ref/id read-model seq unification).
      seq: communityMessage.seq,
    })
    .from(communityMessage)
    .where(eq(communityMessage.channelId, target.channelId))
    .orderBy(desc(communityMessage.createdAt), desc(communityMessage.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Batched form of `getLatestMessage` for the mass mark-read path.
 *
 * Returns one row per channel that HAS messages — empty channels are omitted
 * from the output. That omission is load-bearing: the invariant forbids
 * writing a read-state row without a `lastReadMessageId`, so the caller must
 * be able to tell "no message → no write" from a single lookup.
 *
 * Same MIN/MAX-per-channel subquery pattern as `getFirstMessageByChannelIds`
 * — one SQL round-trip regardless of channel count.
 */
export async function getLatestMessagesByChannelIds(
  db: Database,
  channelIds: string[]
): Promise<Array<{ channelId: string; id: string; createdAt: string; seq: number }>> {
  if (channelIds.length === 0) return [];

  // D1 caps a statement at 100 bound params. Chunk the `inArray` subquery — each
  // channel id lands in exactly one chunk (chunks partition), so the per-channel
  // GROUP BY MAX is complete within its chunk; concat + the existing per-channel
  // dedup below merges losslessly.
  const runChunk = (ids: string[]) => {
    const latestDates = db
      .select({
        channelId: communityMessage.channelId,
        maxCreatedAt: sql<string>`MAX(${communityMessage.createdAt})`.as("max_created_at"),
      })
      .from(communityMessage)
      .where(inArray(communityMessage.channelId, ids))
      .groupBy(communityMessage.channelId)
      .as("latest_dates");

    return db
      .select({
        channelId: communityMessage.channelId,
        id: communityMessage.id,
        createdAt: communityMessage.createdAt,
        // `seq` so `markAllServerChannelsRead` can store `lastReadSeq` per
        // channel (ref/id read-model seq unification).
        seq: communityMessage.seq,
      })
      .from(communityMessage)
      .innerJoin(
        latestDates,
        and(
          eq(communityMessage.channelId, latestDates.channelId),
          eq(communityMessage.createdAt, latestDates.maxCreatedAt)
        )
      );
  };

  const rows = (
    await Promise.all(chunk(channelIds, D1_MAX_IN_PARAMS).map(runChunk))
  ).flat();

  // Deduplicate on channelId: two messages in the same channel could share an
  // exact `createdAt` (millisecond collisions on batched inserts). Pick the
  // greater id — mirrors the `desc(createdAt), desc(id)` order used by
  // `getLatestMessage` so single-vs-batched callers agree.
  const bestByChannel = new Map<string, { channelId: string; id: string; createdAt: string; seq: number }>();
  for (const r of rows) {
    if (!r.channelId) continue;
    const existing = bestByChannel.get(r.channelId);
    if (!existing || r.id > existing.id) {
      bestByChannel.set(r.channelId, {
        channelId: r.channelId,
        id: r.id,
        createdAt: r.createdAt,
        seq: r.seq,
      });
    }
  }
  return Array.from(bestByChannel.values());
}

export async function getFirstMessageByChannelIds(db: Database, channelIds: string[]) {
  if (channelIds.length === 0) return [];
  // Use a subquery to get the min createdAt per channel, then join to get the
  // content. Chunk the `inArray` for D1's 100-param limit — GROUP BY channelId
  // partitions cleanly across chunks (defensive; input is page-bounded today).
  const runChunk = (ids: string[]) => {
    const firstDates = db
      .select({
        channelId: communityMessage.channelId,
        minCreatedAt: sql<string>`MIN(${communityMessage.createdAt})`.as("min_created_at"),
      })
      .from(communityMessage)
      .where(inArray(communityMessage.channelId, ids))
      .groupBy(communityMessage.channelId)
      .as("first_dates");

    return db
      .select({
        channelId: communityMessage.channelId,
        content: communityMessage.content,
      })
      .from(communityMessage)
      .innerJoin(
        firstDates,
        and(
          eq(communityMessage.channelId, firstDates.channelId),
          eq(communityMessage.createdAt, firstDates.minCreatedAt)
        )
      );
  };

  const rows = (
    await Promise.all(chunk(channelIds, D1_MAX_IN_PARAMS).map(runChunk))
  ).flat();

  // Deduplicate in case of exact same createdAt within a channel
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.channelId || seen.has(r.channelId)) return false;
    seen.add(r.channelId);
    return true;
  });
}

/**
 * Look up a single message by (channel-or-DM scope, seq). `seq === 0` is the
 * legacy pre-migration sentinel — callers must reject it before calling this
 * (see `resolve`/`bumpReadCursor` routes), it is never a real, addressable
 * message.
 */
export async function getMessageByChannelAndSeq(
  db: Database,
  target: { channelId: string },
  seq: number
) {
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      seq: communityMessage.seq,
      replyToId: communityMessage.replyToId,
    })
    .from(communityMessage)
    .where(and(eq(communityMessage.channelId, target.channelId), eq(communityMessage.seq, seq)));
  return rows[0] ?? null;
}

/**
 * Lean by-id lookup for the unread-wake rebuild path
 * (`buildUnreadWakeCommand`, plan §8/minimal-wake-queue-unread-notice). NO
 * author join and NO message-body selection — a missing/deleted author row
 * must not make an otherwise-real message look missing, and the wake
 * command never carries message content (the daemon prompts `inbox pull`).
 */
export async function getWakeMessageScopeById(
  db: Database,
  messageId: string
): Promise<{
  id: string;
  seq: number;
  authorId: string;
  channelId: string;
} | null> {
  const rows = await db
    .select({
      id: communityMessage.id,
      seq: communityMessage.seq,
      authorId: communityMessage.authorId,
      channelId: communityMessage.channelId,
    })
    .from(communityMessage)
    .where(eq(communityMessage.id, messageId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMessage(db: Database, messageId: string) {
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      embeds: communityMessage.embeds,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      // Needed by the wake producer's `toAgentMessage(messageRow)` (plan §8) —
      // `enqueueBotWakes` is called from `message-handler.ts` with this exact
      // row, no separate re-fetch.
      seq: communityMessage.seq,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(eq(communityMessage.id, messageId));
  const row = rows[0];
  if (!row) return null;
  return { ...row, embeds: safeParseEmbeds(row.embeds, row.id) };
}

/**
 * Idempotency lookup for the message-send dedup path (mutation-idempotency
 * plan). Returns the message this author already committed under `nonce`, or
 * null if none. Same select/return shape as `getMessage` so the send handler
 * can return the existing row as-is (deduped resend). Backed by the partial
 * unique index `uq_message_author_client_nonce (author_id, client_nonce)`.
 */
export async function getMessageByAuthorAndNonce(
  db: Database,
  authorId: string,
  nonce: string
) {
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      embeds: communityMessage.embeds,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      seq: communityMessage.seq,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(
      and(
        eq(communityMessage.authorId, authorId),
        eq(communityMessage.clientNonce, nonce)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, embeds: safeParseEmbeds(row.embeds, row.id) };
}

/** Update only the author's own message content. The author predicate lives in
 * the write itself so a stale permission check cannot edit another row. */
export async function updateOwnMessageContent(
  db: Database,
  data: { messageId: string; authorId: string; content: string }
) {
  const [updated] = await db
    .update(communityMessage)
    .set({ content: data.content })
    .where(and(eq(communityMessage.id, data.messageId), eq(communityMessage.authorId, data.authorId)))
    .returning({ id: communityMessage.id, channelId: communityMessage.channelId, content: communityMessage.content });
  return updated ?? null;
}

// No ordering guarantee — callers build a Map<id, row> and hydrate by id.
// Unknown ids silently drop out via the natural WHERE id IN (...) semantics.
//
// `seq` is included so callers resolving a thread's parent message (e.g. the
// threads route, plan community-channel-ref.md §3) can surface the parent's
// per-channel sequence without a separate lookup.
export async function getMessagesByIds(db: Database, ids: string[]) {
  if (ids.length === 0) return [];
  // `ids` are child-thread openers under one channel — unbounded on a
  // busy forum. Chunk for D1's 100-param limit; no order/limit → concat.
  const rows = (
    await Promise.all(
      chunk(ids, D1_MAX_IN_PARAMS).map((batch) =>
        db
          .select({
            id: communityMessage.id,
            authorId: communityMessage.authorId,
            content: communityMessage.content,
            type: communityMessage.type,
            mentionType: communityMessage.mentionType,
            replyToId: communityMessage.replyToId,
            embeds: communityMessage.embeds,
            createdAt: communityMessage.createdAt,
            channelId: communityMessage.channelId,
            seq: communityMessage.seq,
            authorName: user.name,
            authorEmail: user.email,
            authorImage: user.image,
          })
          .from(communityMessage)
          .innerJoin(user, eq(communityMessage.authorId, user.id))
          .where(inArray(communityMessage.id, batch))
      )
    )
  ).flat();
  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
}

/**
 * Every message stamped with `friendshipId` (approval-card DMs), with the two
 * access-member peer user ids of the DM channel it lives on. Backs the
 * `channel:message_updated` fanout on approve/deny/supersede/accept — the
 * caller emits one event per referencing message to each DM peer so both
 * first-hop and second-hop cards (J3) rehydrate without a refetch. Small result
 * set (≤2 in practice). Only DM-scoped card messages are ever stamped.
 */
export async function listMessagesReferencingFriendship(
  db: Database,
  friendshipId: string
): Promise<Array<{ messageId: string; channelId: string; peerUserIds: string[] }>> {
  const msgRows = await db
    .select({
      messageId: communityMessage.id,
      channelId: communityMessage.channelId,
    })
    .from(communityMessage)
    .where(eq(communityMessage.friendshipId, friendshipId));
  if (msgRows.length === 0) return [];

  const channelIds = [...new Set(msgRows.map((r) => r.channelId))];
  const memberRows = await db
    .select({
      channelId: communityChannelMember.channelId,
      userId: communityChannelMember.userId,
    })
    .from(communityChannelMember)
    .where(
      and(
        inArray(communityChannelMember.channelId, channelIds),
        eq(communityChannelMember.relation, "access")
      )
    );
  const peersByChannel = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = peersByChannel.get(m.channelId) ?? [];
    list.push(m.userId);
    peersByChannel.set(m.channelId, list);
  }

  return msgRows.map((r) => ({
    messageId: r.messageId,
    channelId: r.channelId,
    peerUserIds: peersByChannel.get(r.channelId) ?? [],
  }));
}

/** Scope a single-id/batched-id lookup to a channel. */
export type MessageScope = { channelId: string };

function scopeCondition(scope: MessageScope) {
  return eq(communityMessage.channelId, scope.channelId);
}

/**
 * Scope-first single-message lookup — `WHERE id = ? AND channelId = ?`.
 * Callers resolving a reply-target preview must use
 * this instead of `getMessage` + a post-hoc `.filter()`: a message whose id a
 * client supplies (e.g. `replyToId`) must never resolve outside the current
 * channel, and folding the check into the WHERE clause makes that
 * impossible to accidentally drop in a future refactor (see AGENTS.md:
 * "scope the queries before, not check the ownership after").
 */
export async function getMessageInScope(db: Database, messageId: string, scope: MessageScope) {
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      embeds: communityMessage.embeds,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(eq(communityMessage.id, messageId), scopeCondition(scope)));
  const row = rows[0];
  if (!row) return null;
  return { ...row, embeds: safeParseEmbeds(row.embeds, row.id) };
}

/** Batched form of `getMessageInScope` — see its doc comment for the "why". */
export async function getMessagesByIdsInScope(db: Database, ids: string[], scope: MessageScope) {
  if (ids.length === 0) return [];
  // `ids` are the reply-target ids of a message page (up to ~200), so this
  // `inArray` is unbounded — chunk for D1's 100-param limit; no order/limit → concat.
  const rows = (
    await Promise.all(
      chunk(ids, D1_MAX_IN_PARAMS).map((batch) =>
        db
          .select({
            id: communityMessage.id,
            authorId: communityMessage.authorId,
            content: communityMessage.content,
            type: communityMessage.type,
            mentionType: communityMessage.mentionType,
            replyToId: communityMessage.replyToId,
            embeds: communityMessage.embeds,
            seq: communityMessage.seq,
            createdAt: communityMessage.createdAt,
            channelId: communityMessage.channelId,
            authorName: user.name,
            discriminator: user.discriminator,
            authorEmail: user.email,
            authorImage: user.image,
          })
          .from(communityMessage)
          .innerJoin(user, eq(communityMessage.authorId, user.id))
          .where(and(inArray(communityMessage.id, batch), scopeCondition(scope)))
      )
    )
  ).flat();
  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
}
