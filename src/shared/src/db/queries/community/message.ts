import { eq, and, desc, lt, or, sql, inArray } from "drizzle-orm";
import {
  communityMessage,
  communityChannel,
  communityDmConversation,
  communityReadState,
  communityMessageSeq,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { createLogger } from "../../../logger";

/** `'channel:<id>'` or `'dm:<id>'` — the `community_message_seq` PK. */
export function scopeKeyForTarget(target: { channelId?: string; dmConversationId?: string }): string {
  if (target.channelId) return `channel:${target.channelId}`;
  if (target.dmConversationId) return `dm:${target.dmConversationId}`;
  throw new Error("scopeKeyForTarget: neither channelId nor dmConversationId provided");
}

/**
 * Atomically claim the next seq value for a scope (channel or DM). A single
 * top-level UPSERT — D1's single-writer serialization makes this race-free
 * for uniqueness on its own, no CTE/transaction needed (see
 * plans/community-agent-cli-bridge.md design §3 for why the CTE-fusion
 * approach is not valid SQLite and was rejected).
 */
async function claimNextSeq(db: Database, scopeKey: string): Promise<number> {
  const rows = await db
    .insert(communityMessageSeq)
    .values({ scopeKey, nextSeq: 1 })
    .onConflictDoUpdate({
      target: communityMessageSeq.scopeKey,
      set: { nextSeq: sql`${communityMessageSeq.nextSeq} + 1` },
    })
    .returning({ nextSeq: communityMessageSeq.nextSeq });
  return rows[0]!.nextSeq;
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

export async function createMessage(
  db: Database,
  data: {
    authorId: string;
    content: string;
    channelId?: string;
    dmConversationId?: string;
    type?: string;
    mentionType?: string;
    replyToId?: string;
    embeds?: string;
  }
) {
  const now = new Date().toISOString();

  // Step 0: atomically claim this scope's next seq (own top-level statement —
  // see design §3 for why this can't be fused into the INSERT below via a
  // CTE). Accepted trade-off: if the INSERT below fails after this succeeds,
  // the counter has a harmless gap — no duplicate seq is ever possible since
  // this claim is independently atomic under D1's single-writer serialization.
  // Do NOT wrap these two statements in a transaction to "fix" this — D1
  // doesn't support one that could express it.
  const scopeKey = scopeKeyForTarget(data);
  const seq = await claimNextSeq(db, scopeKey);

  // Pass `createdAt: now` explicitly so `msg.createdAt` matches the exact
  // string we write to `channel.lastMessageAt` / `dmConversation.lastMessageAt`
  // and to the author's read-state watermark below. Without this, the schema
  // `$defaultFn` fires a microsecond later and the timestamps diverge — the
  // inbox predicate `lastMessageAt > lastReadAt` would then wrongly fire for
  // the author's own send on a cold read.
  const rows = await db
    .insert(communityMessage)
    .values({
      authorId: data.authorId,
      content: data.content,
      channelId: data.channelId ?? null,
      dmConversationId: data.dmConversationId ?? null,
      type: data.type ?? "default",
      mentionType: data.mentionType ?? null,
      replyToId: data.replyToId ?? null,
      embeds: data.embeds ?? null,
      createdAt: now,
      seq,
    })
    .returning();

  const msg = rows[0]!;

  if (data.channelId) {
    await db
      .update(communityChannel)
      .set({
        lastMessageAt: now,
        messageCount: sql`${communityChannel.messageCount} + 1`,
      })
      .where(eq(communityChannel.id, data.channelId));

    // Author read-watermark: advance the sender's own read-state to this
    // message so `listUnreadChannels` (predicate: lastMessageAt > lastReadAt)
    // never surfaces the channel the author just sent in. Keep this inline —
    // future readers should see the invariant next to the `lastMessageAt`
    // bump. Upsert against the `idx_read_state_user_channel` partial-unique
    // index (same shape as `markReadToMessageBuilder`). `lastReadSeq` is
    // extended here too (design §4) — required for wake-filter correctness:
    // every author (bot or human) must have its own `lastReadSeq` stay in
    // lockstep with its sends, or `enqueueBotWakes` sees a stale watermark.
    await db
      .insert(communityReadState)
      .values({
        userId: data.authorId,
        channelId: data.channelId,
        dmConversationId: null,
        lastReadAt: now,
        lastReadMessageId: msg.id,
        lastReadSeq: seq,
      })
      .onConflictDoUpdate({
        target: [communityReadState.userId, communityReadState.channelId],
        targetWhere: sql`${communityReadState.channelId} IS NOT NULL`,
        set: { lastReadAt: now, lastReadMessageId: msg.id, lastReadSeq: seq },
        setWhere: sql`${communityReadState.lastReadSeq} < ${seq}`,
      });
  }

  if (data.dmConversationId) {
    await db
      .update(communityDmConversation)
      .set({ lastMessageAt: now })
      .where(eq(communityDmConversation.id, data.dmConversationId));

    // Author read-watermark (DM path). Upsert against the
    // `idx_read_state_user_dm` partial-unique index. Same invariant as the
    // channel branch: keep the sender's watermark equal to the message they
    // just sent so their inbox does not flag it as unread. `lastReadSeq`
    // extended per design §4 — see the channel branch comment above.
    await db
      .insert(communityReadState)
      .values({
        userId: data.authorId,
        channelId: null,
        dmConversationId: data.dmConversationId,
        lastReadAt: now,
        lastReadMessageId: msg.id,
        lastReadSeq: seq,
      })
      .onConflictDoUpdate({
        target: [communityReadState.userId, communityReadState.dmConversationId],
        targetWhere: sql`${communityReadState.dmConversationId} IS NOT NULL`,
        set: { lastReadAt: now, lastReadMessageId: msg.id, lastReadSeq: seq },
        setWhere: sql`${communityReadState.lastReadSeq} < ${seq}`,
      });
  }

  return msg;
}

/**
 * Hard-delete a message row by id. Reserved for rollback of a message that
 * was written moments before but its dependent row (approval-request, etc.)
 * failed to persist. Do NOT use this for user-facing message deletion — that
 * path should soft-delete or set a tombstone.
 */
export async function hardDeleteMessage(db: Database, messageId: string) {
  await db.delete(communityMessage).where(eq(communityMessage.id, messageId));
}

export async function listMessages(
  db: Database,
  opts: {
    channelId?: string;
    dmConversationId?: string;
    cursor?: { createdAt: string; id: string };
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const conditions: ReturnType<typeof eq>[] = [];

  if (opts.channelId) {
    conditions.push(eq(communityMessage.channelId, opts.channelId));
  }
  if (opts.dmConversationId) {
    conditions.push(eq(communityMessage.dmConversationId, opts.dmConversationId));
  }

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
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      embeds: communityMessage.embeds,
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions))
    .orderBy(desc(communityMessage.createdAt), desc(communityMessage.id))
    .limit(limit);

  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
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
  target: { channelId: string } | { dmConversationId: string }
): Promise<{ id: string; createdAt: string } | null> {
  const cond =
    "channelId" in target
      ? eq(communityMessage.channelId, target.channelId)
      : eq(communityMessage.dmConversationId, target.dmConversationId);

  const rows = await db
    .select({
      id: communityMessage.id,
      createdAt: communityMessage.createdAt,
    })
    .from(communityMessage)
    .where(cond)
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
): Promise<Array<{ channelId: string; id: string; createdAt: string }>> {
  if (channelIds.length === 0) return [];

  const latestDates = db
    .select({
      channelId: communityMessage.channelId,
      maxCreatedAt: sql<string>`MAX(${communityMessage.createdAt})`.as("max_created_at"),
    })
    .from(communityMessage)
    .where(inArray(communityMessage.channelId, channelIds))
    .groupBy(communityMessage.channelId)
    .as("latest_dates");

  const rows = await db
    .select({
      channelId: communityMessage.channelId,
      id: communityMessage.id,
      createdAt: communityMessage.createdAt,
    })
    .from(communityMessage)
    .innerJoin(
      latestDates,
      and(
        eq(communityMessage.channelId, latestDates.channelId),
        eq(communityMessage.createdAt, latestDates.maxCreatedAt)
      )
    );

  // Deduplicate on channelId: two messages in the same channel could share an
  // exact `createdAt` (millisecond collisions on batched inserts). Pick the
  // greater id — mirrors the `desc(createdAt), desc(id)` order used by
  // `getLatestMessage` so single-vs-batched callers agree.
  const bestByChannel = new Map<string, { channelId: string; id: string; createdAt: string }>();
  for (const r of rows) {
    if (!r.channelId) continue;
    const existing = bestByChannel.get(r.channelId);
    if (!existing || r.id > existing.id) {
      bestByChannel.set(r.channelId, {
        channelId: r.channelId,
        id: r.id,
        createdAt: r.createdAt,
      });
    }
  }
  return Array.from(bestByChannel.values());
}

export async function getFirstMessageByChannelIds(db: Database, channelIds: string[]) {
  if (channelIds.length === 0) return [];
  // Use a subquery to get the min createdAt per channel, then join to get the content
  const firstDates = db
    .select({
      channelId: communityMessage.channelId,
      minCreatedAt: sql<string>`MIN(${communityMessage.createdAt})`.as("min_created_at"),
    })
    .from(communityMessage)
    .where(inArray(communityMessage.channelId, channelIds))
    .groupBy(communityMessage.channelId)
    .as("first_dates");

  const rows = await db
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
  target: { channelId?: string; dmConversationId?: string },
  seq: number
) {
  const scopeCond = target.channelId
    ? eq(communityMessage.channelId, target.channelId)
    : eq(communityMessage.dmConversationId, target.dmConversationId!);

  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      seq: communityMessage.seq,
    })
    .from(communityMessage)
    .where(and(scopeCond, eq(communityMessage.seq, seq)));
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
  channelId: string | null;
  dmConversationId: string | null;
} | null> {
  const rows = await db
    .select({
      id: communityMessage.id,
      seq: communityMessage.seq,
      authorId: communityMessage.authorId,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
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
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
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

// No ordering guarantee — callers build a Map<id, row> and hydrate by id.
// Unknown ids silently drop out via the natural WHERE id IN (...) semantics.
export async function getMessagesByIds(db: Database, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      embeds: communityMessage.embeds,
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(inArray(communityMessage.id, ids));
  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
}

/** Scope a single-id/batched-id lookup to a channel or DM. */
export type MessageScope = { channelId: string } | { dmConversationId: string };

function scopeCondition(scope: MessageScope) {
  return "channelId" in scope
    ? eq(communityMessage.channelId, scope.channelId)
    : eq(communityMessage.dmConversationId, scope.dmConversationId);
}

/**
 * Scope-first single-message lookup — `WHERE id = ? AND (channelId = ? OR
 * dmConversationId = ?)`. Callers resolving a reply-target preview must use
 * this instead of `getMessage` + a post-hoc `.filter()`: a message whose id a
 * client supplies (e.g. `replyToId`) must never resolve outside the current
 * channel/DM, and folding the check into the WHERE clause makes that
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
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
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
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      embeds: communityMessage.embeds,
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(inArray(communityMessage.id, ids), scopeCondition(scope)));
  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
}
