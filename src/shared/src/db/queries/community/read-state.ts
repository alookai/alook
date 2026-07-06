import { eq, and, inArray, sql } from "drizzle-orm";
import {
  communityReadState,
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import { getLatestMessagesByChannelIds } from "./message";

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
export async function markAllServerChannelsRead(
  db: Database,
  userId: string
): Promise<number> {
  const channelRows = await db
    .select({ channelId: communityChannel.id })
    .from(communityServerMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.serverId, communityServerMember.serverId)
    )
    .where(eq(communityServerMember.userId, userId));

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
  for (const u of toUpdate) {
    await db
      .update(communityReadState)
      .set({ lastReadAt: u.createdAt, lastReadMessageId: u.msgId })
      .where(eq(communityReadState.id, u.id));
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
