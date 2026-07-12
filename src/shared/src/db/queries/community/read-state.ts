import { eq, and, or, inArray, isNull, isNotNull, lt, sql } from "drizzle-orm";
import {
  communityReadState,
  communityCategory,
  communityChannel,
  communityChannelMember,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import { getLatestMessagesByChannelIds, getMessageByChannelAndSeq } from "./message";

/**
 * # Community read-state invariant
 *
 * A row in `communityReadState` means "user U has read up to and including
 * this specific message." Therefore, whenever a row exists:
 *
 *     lastReadMessageId IS NOT NULL
 *     AND lastReadAt === getMessage(lastReadMessageId).createdAt
 *
 * `lastReadAt` is a denormalized cache of the message's own `createdAt` — it
 * exists only to keep the inbox unread predicate
 * (`channel.lastMessageAt > lastReadAt`) a single-column comparison. It is
 * NEVER the semantic source of truth on its own.
 *
 * Consequences for callers:
 * - If a channel/DM has no messages yet, there is NO row — mass mark-read is
 *   a no-op. The inbox query already filters `isNotNull(lastMessageAt)` so
 *   this doesn't leak unread noise.
 * - Every write path routes through `markReadToMessageBuilder` (batchable)
 *   or `markReadToMessage` (single-write). Both take a `message: { id,
 *   createdAt }` and enforce alignment by construction.
 * - NEVER write `{ lastReadAt: now, lastReadMessageId: null }`. If a future
 *   path genuinely wants to erase the pointer, delete the row instead.
 */

function buildTargetFilter(data: {
  userId: string;
  channelId?: string;
  dmConversationId?: string;
}) {
  const conditions = [eq(communityReadState.userId, data.userId)];

  if (data.channelId) {
    conditions.push(eq(communityReadState.channelId, data.channelId));
  }
  if (data.dmConversationId) {
    conditions.push(
      eq(communityReadState.dmConversationId, data.dmConversationId)
    );
  }

  return and(...conditions)!;
}

/**
 * Canonical batchable channel/DM read-state upsert.
 *
 * INVARIANT: lastReadAt === message.createdAt AND lastReadMessageId = message.id
 *
 * The caller passes the target message row (id + createdAt), never a bare
 * timestamp — that's how the invariant is enforced by construction. To mark
 * a channel/DM read "as of now" the caller must first resolve `getLatestMessage`
 * and, if it's null (empty channel), SKIP the write. This helper does not
 * accept an "unknown message" shape on purpose.
 *
 * Returns the Drizzle INSERT builder synchronously so it can be composed into
 * `db.batch([...])` alongside sibling writes (mention clear, for-you dismiss).
 *
 * Exactly one of `channelId` / `dmConversationId` must be provided; the
 * upsert targets the matching partial-unique index
 * (`idx_read_state_user_channel` or `idx_read_state_user_dm`).
 */
// lastReadSeq intentionally not maintained here — humans only, bot-wake
// filter never reads a human's row (see plans/community-agent-cli-bridge.md
// design §4 for the full accounting of which of the four read-state writers
// do/don't need to thread `lastReadSeq` through).
export function markReadToMessageBuilder(
  db: Database,
  data: {
    userId: string;
    channelId?: string;
    dmConversationId?: string;
    message: { id: string; createdAt: string };
  }
) {
  const { userId, channelId, dmConversationId, message } = data;

  if ((channelId && dmConversationId) || (!channelId && !dmConversationId)) {
    throw new Error(
      "markReadToMessageBuilder: exactly one of channelId or dmConversationId is required"
    );
  }

  // Monotone guard: `setWhere` requires the incoming `lastReadAt` to be
  // strictly greater than the row's current value. If a stale client PUT
  // arrives (channel switch → return, remounted `useChannelWatermark`
  // resets its local `maxSeen` and picks an older mid-viewport row as
  // its first advance), the UPDATE portion no-ops and the existing row
  // wins. INSERT (no row yet) is unaffected — you can't regress what
  // doesn't exist. Sibling pattern to `createMessage`'s author-watermark
  // upsert, which guards on `lastReadSeq < seq` for the same reason.
  //
  // Timestamp comparison is safe: `lastReadAt` is a TEXT ISO-8601 string
  // (see schema note) and SQLite compares those lexicographically, which
  // matches temporal order for ISO-8601.
  if (channelId) {
    return db
      .insert(communityReadState)
      .values({
        userId,
        channelId,
        dmConversationId: null,
        lastReadAt: message.createdAt,
        lastReadMessageId: message.id,
      })
      .onConflictDoUpdate({
        target: [communityReadState.userId, communityReadState.channelId],
        targetWhere: sql`${communityReadState.channelId} IS NOT NULL`,
        set: {
          lastReadAt: message.createdAt,
          lastReadMessageId: message.id,
        },
        setWhere: sql`${communityReadState.lastReadAt} < ${message.createdAt}`,
      });
  }

  return db
    .insert(communityReadState)
    .values({
      userId,
      channelId: null,
      dmConversationId: dmConversationId!,
      lastReadAt: message.createdAt,
      lastReadMessageId: message.id,
    })
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.dmConversationId],
      targetWhere: sql`${communityReadState.dmConversationId} IS NOT NULL`,
      set: {
        lastReadAt: message.createdAt,
        lastReadMessageId: message.id,
      },
      setWhere: sql`${communityReadState.lastReadAt} < ${message.createdAt}`,
    });
}

/**
 * Async sibling of `markReadToMessageBuilder` for the non-batch DM / thread
 * routes.
 *
 * INVARIANT: lastReadAt === message.createdAt AND lastReadMessageId = message.id
 *
 * Executes the upsert immediately (no batch composition) and returns void.
 * The routes don't consume the returned row today — see `PUT /dm/:id/read`
 * and `PUT /threads/:id/read` which respond `{ ok: true }`.
 */
// lastReadSeq intentionally not maintained here — see comment on
// `markReadToMessageBuilder` above.
export async function markReadToMessage(
  db: Database,
  data: {
    userId: string;
    channelId?: string;
    dmConversationId?: string;
    message: { id: string; createdAt: string };
  }
): Promise<void> {
  await markReadToMessageBuilder(db, data);
}

/**
 * INVARIANT: every row this writes satisfies
 * lastReadAt === message.createdAt AND lastReadMessageId = message.id.
 *
 * Mark every top-level channel the viewer's servers contain as read at that
 * channel's latest message. Empty channels are SKIPPED — no row inserted,
 * no row updated. Returns the number of channels that actually got a write.
 *
 * Semantics change from the pre-invariant version:
 * - Old: return `channelIds.length` (every reachable channel).
 * - New: return the count of channels that had at least one message. Empty
 *   channels stay empty in `communityReadState` because the invariant
 *   forbids `lastReadMessageId = null` rows.
 */
// lastReadSeq intentionally not maintained here — see comment on
// `markReadToMessageBuilder` above.
export async function markAllServerChannelsRead(
  db: Database,
  userId: string
): Promise<number> {
  // Scope to channels the viewer may actually see: a private-category channel
  // only counts if they're an admin, its creator, or an added member —
  // otherwise "mark all read" would write read-state rows for inaccessible
  // channels. (Child threads/forum posts are included as before — their
  // read-state rows carry no content, so there's no leak; the privacy filter
  // below only gates the top-level private-category channels.)
  const channelRows = await db
    .select({ channelId: communityChannel.id })
    .from(communityServerMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.serverId, communityServerMember.serverId)
    )
    .leftJoin(communityCategory, eq(communityCategory.id, communityChannel.categoryId))
    .leftJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityChannel.id),
        eq(communityChannelMember.userId, userId)
      )
    )
    .where(
      and(
        eq(communityServerMember.userId, userId),
        or(
          isNull(communityChannel.categoryId),
          eq(communityCategory.private, 0),
          eq(communityServerMember.role, "owner"),
          eq(communityServerMember.role, "admin"),
          eq(communityChannel.creatorId, userId),
          isNotNull(communityChannelMember.id)
        )
      )
    );

  const channelIds = channelRows.map((r) => r.channelId);
  if (channelIds.length === 0) return 0;

  const latest = await getLatestMessagesByChannelIds(db, channelIds);
  if (latest.length === 0) return 0;

  // Existing rows for these channels — used to split into UPDATE vs INSERT
  // batches so we don't run one query per channel. The upsert index only
  // fires per statement; we can't fold every channel into a single insert
  // with `onConflictDoUpdate` because each channel has a DIFFERENT
  // `(lastReadAt, lastReadMessageId)` pair.
  const existing = await db
    .select({
      id: communityReadState.id,
      channelId: communityReadState.channelId,
    })
    .from(communityReadState)
    .where(
      and(
        eq(communityReadState.userId, userId),
        inArray(
          communityReadState.channelId,
          latest.map((l) => l.channelId)
        )
      )
    );

  const existingByChannel = new Map<string, string>();
  for (const row of existing) {
    if (row.channelId) existingByChannel.set(row.channelId, row.id);
  }

  // Split latest into (a) rows we need to UPDATE by primary key and (b) rows
  // we need to INSERT fresh.
  const toUpdate: Array<{ id: string; channelId: string; msgId: string; createdAt: string }> = [];
  const toInsert: Array<{ channelId: string; msgId: string; createdAt: string }> = [];
  for (const l of latest) {
    const existingId = existingByChannel.get(l.channelId);
    if (existingId) {
      toUpdate.push({ id: existingId, channelId: l.channelId, msgId: l.id, createdAt: l.createdAt });
    } else {
      toInsert.push({ channelId: l.channelId, msgId: l.id, createdAt: l.createdAt });
    }
  }

  // Perform updates row-by-row (one small UPDATE per row is fine — this path
  // fires on user click "Mark all read", not in a hot loop). Alternative
  // would be a `CASE WHEN ...` bulk UPDATE, which is uglier and only wins
  // above ~50 channels.
  //
  // Monotone guard mirrors `markReadToMessageBuilder`: only advance rows
  // whose current `lastReadAt` is strictly older than the channel's
  // latest. If a stale row happens to already sit ahead of the current
  // latest (rare — usually only under concurrent writes or right after
  // a message delete), leave it alone rather than regressing.
  for (const u of toUpdate) {
    await db
      .update(communityReadState)
      .set({ lastReadAt: u.createdAt, lastReadMessageId: u.msgId })
      .where(
        and(
          eq(communityReadState.id, u.id),
          lt(communityReadState.lastReadAt, u.createdAt)
        )
      );
  }

  if (toInsert.length > 0) {
    await db.insert(communityReadState).values(
      toInsert.map((i) => ({
        userId,
        channelId: i.channelId,
        dmConversationId: null,
        lastReadAt: i.createdAt,
        lastReadMessageId: i.msgId,
      }))
    );
  }

  return latest.length;
}

/**
 * The agent `ack` route's cursor-advance — the ONLY writer of `lastReadSeq`
 * outside `createMessage`'s author-watermark upsert (design §4). `Cursor =
 * { channel, seq }` carries no message id, so this first resolves
 * `(target, seq) → { id, createdAt }` via `getMessageByChannelAndSeq`, then
 * upserts all three of `lastReadSeq`/`lastReadMessageId`/`lastReadAt`
 * together — NEVER bump `lastReadSeq` alone, or the table's documented
 * invariant (`lastReadAt === getMessage(lastReadMessageId).createdAt`)
 * breaks for any row this touches.
 *
 * `MAX(existing, incoming)` semantics on the agent cursor, applied together:
 * if the resolved message's `seq` is not ahead of the row's current
 * `lastReadSeq`, the whole bump is a no-op; the existing pointer wins. Never
 * regress `lastReadSeq`, `lastReadMessageId`, and `lastReadAt` independently
 * of one another.
 *
 * Returns `null` if `seq` doesn't resolve to a real message in that scope
 * (caller returns 404/ignores per §7's `ack` route spec).
 */
export async function bumpReadCursor(
  db: Database,
  userId: string,
  target: { channelId?: string; dmConversationId?: string },
  seq: number
): Promise<{ id: string; createdAt: string; seq: number } | null> {
  const message = await getMessageByChannelAndSeq(db, target, seq);
  if (!message) return null;

  const existing = await getReadState(db, { userId, ...target });

  // MAX semantics: if the resolved seq is not ahead of what's already
  // recorded, this is a no-op — never regress any of the three fields.
  if (existing && existing.lastReadSeq >= seq && existing.lastReadMessageId) {
    return { id: existing.lastReadMessageId!, createdAt: existing.lastReadAt, seq: existing.lastReadSeq };
  }

  if (target.channelId) {
    await db
      .insert(communityReadState)
      .values({
        userId,
        channelId: target.channelId,
        dmConversationId: null,
        lastReadAt: message.createdAt,
        lastReadMessageId: message.id,
        lastReadSeq: seq,
      })
      .onConflictDoUpdate({
        target: [communityReadState.userId, communityReadState.channelId],
        targetWhere: sql`${communityReadState.channelId} IS NOT NULL`,
        set: { lastReadAt: message.createdAt, lastReadMessageId: message.id, lastReadSeq: seq },
        setWhere: sql`${communityReadState.lastReadSeq} < ${seq}`,
      });
  } else {
    await db
      .insert(communityReadState)
      .values({
        userId,
        channelId: null,
        dmConversationId: target.dmConversationId!,
        lastReadAt: message.createdAt,
        lastReadMessageId: message.id,
        lastReadSeq: seq,
      })
      .onConflictDoUpdate({
        target: [communityReadState.userId, communityReadState.dmConversationId],
        targetWhere: sql`${communityReadState.dmConversationId} IS NOT NULL`,
        set: { lastReadAt: message.createdAt, lastReadMessageId: message.id, lastReadSeq: seq },
        setWhere: sql`${communityReadState.lastReadSeq} < ${seq}`,
      });
  }

  return { id: message.id, createdAt: message.createdAt, seq };
}

export async function getReadState(
  db: Database,
  data: {
    userId: string;
    channelId?: string;
    dmConversationId?: string;
  }
) {
  const rows = await db
    .select()
    .from(communityReadState)
    .where(buildTargetFilter(data));
  return rows[0] ?? null;
}

/**
 * Thin `lastReadSeq` accessor for the unread-wake rebuild path
 * (`buildUnreadWakeCommand`). No row (bot never read this scope) is "never
 * read" — same convention `findWakeCandidates` already uses (`?? 0`).
 */
export async function getWakeReadSeq(
  db: Database,
  botUserId: string,
  scope: { channelId?: string; dmConversationId?: string }
): Promise<number> {
  const state = await getReadState(db, { userId: botUserId, ...scope });
  return state?.lastReadSeq ?? 0;
}
