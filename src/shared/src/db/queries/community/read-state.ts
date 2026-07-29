import { eq, and, inArray, lt, sql } from "drizzle-orm";
import { communityReadState } from "../../community-schema";
import type { Database } from "../../index";
import { chunk, maxRowsPerInsert, D1_MAX_IN_PARAMS } from "../_chunk";
import {
  getLatestMessagesByChannelIds,
  getMessageByChannelAndSeq,
} from "./message";
import { listDMs } from "./dm";

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

function buildTargetFilter(data: { userId: string; channelId: string }) {
  return and(
    eq(communityReadState.userId, data.userId),
    eq(communityReadState.channelId, data.channelId)
  )!;
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
 * `channelId` is the only scope; the upsert targets the plain unique
 * `(user_id, channel_id)`.
 */
// lastReadSeq intentionally not maintained here — humans only, bot-wake
// filter never reads a human's row (see plans/community-agent-cli-bridge.md
// design §4 for the full accounting of which of the four read-state writers
// do/don't need to thread `lastReadSeq` through).
export function markReadToMessageBuilder(
  db: Database,
  data: {
    userId: string;
    channelId: string;
    message: { id: string; createdAt: string };
  }
) {
  const { userId, channelId, message } = data;

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
  return db
    .insert(communityReadState)
    .values({
      userId,
      channelId,
      lastReadAt: message.createdAt,
      lastReadMessageId: message.id,
    })
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.channelId],
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
    channelId: string;
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
  userId: string,
  visibleChannelIds: string[]
): Promise<number> {
  // Scope to the channels the viewer may see — the same visible-id set the
  // inbox unread + mentions consumers use (resolved once per fetch via
  // `listVisibleChannelIdsForUser`). Convergence on the id set replaces the
  // old inlined category `or()`, which climbed nothing and so evaluated child
  // threads/forum-posts by their own (always-NULL) categoryId as public. The
  // id set parent-climbs, so a child under a private parent the viewer can't
  // see is now correctly EXCLUDED — mark-all no longer writes read-state rows
  // for channels behind an invisible private parent.
  if (visibleChannelIds.length === 0) return 0;
  const channelIds = visibleChannelIds;

  const latest = await getLatestMessagesByChannelIds(db, channelIds);
  if (latest.length === 0) return 0;

  // Existing rows for these channels — used to split into UPDATE vs INSERT
  // batches so we don't run one query per channel. The upsert index only
  // fires per statement; we can't fold every channel into a single insert
  // with `onConflictDoUpdate` because each channel has a DIFFERENT
  // `(lastReadAt, lastReadMessageId)` pair.
  // `latest` ranges over channels-with-messages (a subset of the visible set,
  // still possibly >100). Chunk the `inArray` for D1's 100-param limit; no
  // order/limit → concat.
  const latestChannelIds = latest.map((l) => l.channelId);
  const existing = (
    await Promise.all(
      chunk(latestChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            id: communityReadState.id,
            channelId: communityReadState.channelId,
          })
          .from(communityReadState)
          .where(
            and(
              eq(communityReadState.userId, userId),
              inArray(communityReadState.channelId, ids)
            )
          )
      )
    )
  ).flat();

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
    // communityReadState emits 6 bind params/row (id $defaultFn, user_id,
    // channel_id, last_read_at, last_read_message_id, last_read_seq default),
    // so cap at floor(100/6)=16 rows/statement for D1's 100-param limit.
    for (const batch of chunk(toInsert, maxRowsPerInsert(6))) {
      await db.insert(communityReadState).values(
        batch.map((i) => ({
          userId,
          channelId: i.channelId,
          lastReadAt: i.createdAt,
          lastReadMessageId: i.msgId,
        }))
      );
    }
  }

  return latest.length;
}

/**
 * DM sibling of `markAllServerChannelsRead`: mark every DM the viewer
 * participates in read at that DM channel's latest message. DMs are channels
 * now, so this resolves the viewer's DM channel ids (via `listDMs`) then reuses
 * the same channel mark-read path. Same invariant, monotone guard, and
 * "empty conversations are skipped" semantics.
 */
// lastReadSeq intentionally not maintained here — see comment on
// `markReadToMessageBuilder` above.
export async function markAllDmsRead(
  db: Database,
  userId: string
): Promise<number> {
  const dms = await listDMs(db, userId);
  const dmChannelIds = dms.map((d) => d.id);
  if (dmChannelIds.length === 0) return 0;
  return markAllServerChannelsRead(db, userId, dmChannelIds);
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
  target: { channelId: string },
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

  await db
    .insert(communityReadState)
    .values({
      userId,
      channelId: target.channelId,
      lastReadAt: message.createdAt,
      lastReadMessageId: message.id,
      lastReadSeq: seq,
    })
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.channelId],
      set: { lastReadAt: message.createdAt, lastReadMessageId: message.id, lastReadSeq: seq },
      setWhere: sql`${communityReadState.lastReadSeq} < ${seq}`,
    });

  return { id: message.id, createdAt: message.createdAt, seq };
}

export async function getReadState(
  db: Database,
  data: {
    userId: string;
    channelId: string;
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
  scope: { channelId: string }
): Promise<number> {
  const state = await getReadState(db, { userId: botUserId, ...scope });
  return state?.lastReadSeq ?? 0;
}
