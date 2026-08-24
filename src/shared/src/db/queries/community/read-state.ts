import { eq, and, sql, type SQL } from "drizzle-orm";
import { communityReadState, communityReadStateRevision } from "../../community-schema";
import type { Database } from "../../index";
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
// `lastReadSeq` IS maintained here now (ref/id read-model seq unification): the
// unread predicate switched from `lastMessageAt > lastReadAt` (timestamp) to
// `EXISTS(message.seq > lastReadSeq)` — the same seq ruler the agent side uses —
// so every human read write must advance `lastReadSeq` too, else a human's read
// never registers under the new predicate (permanent phantom-unread). `seq`
// co-advances with `createdAt` (both from the same message), and the monotone
// guard uses `lastReadSeq` so same-timestamp messages still order correctly.
export function markReadToMessageBuilder(
  db: Database,
  data: {
    userId: string;
    channelId: string;
    message: { id: string; createdAt: string; seq: number };
  }
) {
  const { userId, channelId, message } = data;

  return db
    .insert(communityReadState)
    .values({
      userId,
      channelId,
      lastReadAt: message.createdAt,
      lastReadMessageId: message.id,
      lastReadSeq: message.seq,
    })
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.channelId],
      set: {
        lastReadAt: message.createdAt,
        lastReadMessageId: message.id,
        lastReadSeq: message.seq,
      },
      setWhere: sql`${communityReadState.lastReadSeq} < ${message.seq}`,
    });
}

export function advanceReadStateRevisionBuilder(db: Database, userId: string) {
  return db
    .insert(communityReadStateRevision)
    .values({ userId, revision: 1 })
    .onConflictDoUpdate({
      target: communityReadStateRevision.userId,
      set: { revision: sql`${communityReadStateRevision.revision} + 1` },
    })
    .returning({ revision: communityReadStateRevision.revision });
}

/**
 * Bulk sibling used by destructive mutations that may replace/remove rows for
 * several human accounts at once. `condition` is evaluated inside the same D1
 * batch immediately before the destructive statement, so a raced loser does
 * not mint revisions for a mutation it did not commit.
 */
export function advanceReadStateRevisionsForUsersBuilder(
  db: Database,
  userIds: string[],
  condition: SQL<unknown>,
) {
  const ids = JSON.stringify([...new Set(userIds)]);
  const selected = db
    .select({
      userId: sql<string>`CAST(value AS TEXT)`.as("user_id"),
      revision: sql<number>`1`.as("revision"),
    })
    .from(sql`json_each(${ids})`)
    .where(condition);
  return db
    .insert(communityReadStateRevision)
    .select(selected)
    .onConflictDoUpdate({
      target: communityReadStateRevision.userId,
      set: { revision: sql`${communityReadStateRevision.revision} + 1` },
    })
    .returning({
      userId: communityReadStateRevision.userId,
      revision: communityReadStateRevision.revision,
    });
}

export function accountReadStateRevisionBuilder(db: Database, userId: string) {
  return db
    .select({ revision: communityReadStateRevision.revision })
    .from(communityReadStateRevision)
    .where(eq(communityReadStateRevision.userId, userId))
    .limit(1);
}

export function accountReadStateRowsBuilder(db: Database, userId: string) {
  return db
    .select({
      channelId: communityReadState.channelId,
      lastReadMessageId: communityReadState.lastReadMessageId,
      lastReadAt: communityReadState.lastReadAt,
      lastReadSeq: communityReadState.lastReadSeq,
    })
    .from(communityReadState)
    .where(eq(communityReadState.userId, userId));
}

export type AccountReadState = {
  channelId: string;
  lastReadMessageId: string | null;
  lastReadAt: string;
  lastReadSeq: number;
};

export type AccountReadStateSnapshot = {
  revision: number;
  readStates: AccountReadState[];
};

export type AccountReadStateRevisionByUser = {
  userId: string;
  revision: number;
};

export async function getAccountReadStateSnapshot(db: Database, userId: string) {
  const revisionQuery = accountReadStateRevisionBuilder(db, userId);
  const readStatesQuery = accountReadStateRowsBuilder(db, userId);
  const [revisionRows, readStates] = await db.batch([
    revisionQuery,
    readStatesQuery,
  ]) as unknown as [Array<{ revision: number }>, AccountReadState[]];
  return { revision: revisionRows[0]?.revision ?? 0, readStates };
}

export type ReadStateAdvance = {
  channelId: string;
  lastReadMessageId: string;
  lastReadAt: string;
  lastReadSeq: number;
};

export type ReadAllResult = {
  count: number;
  revision: number | null;
};

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
// `lastReadSeq` maintained via the builder — see comment on
// `markReadToMessageBuilder` above.
export async function markReadToMessage(
  db: Database,
  data: {
    userId: string;
    channelId: string;
    message: { id: string; createdAt: string; seq: number };
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
  userId: string,
  visibleChannelIds: string[]
): Promise<ReadAllResult> {
  // Scope to the channels the viewer may see — the same visible-id set the
  // inbox unread + mentions consumers use (resolved once per fetch via
  // `listVisibleChannelIdsForUser`). Convergence on the id set replaces the
  // old inlined category `or()`, which climbed nothing and so evaluated child
  // child threads by their own (always-NULL) categoryId as public. The
  // id set parent-climbs, so a child under a private parent the viewer can't
  // see is now correctly EXCLUDED — mark-all no longer writes read-state rows
  // for channels behind an invisible private parent.
  if (visibleChannelIds.length === 0) return { count: 0, revision: null };
  const channelIds = visibleChannelIds;

  const latest = await getLatestMessagesByChannelIds(db, channelIds);
  if (latest.length === 0) return { count: 0, revision: null };

  const statements = latest.map((message) => markReadToMessageBuilder(db, {
    userId,
    channelId: message.channelId,
    message,
  }));
  const results = await db.batch([
    ...statements,
    advanceReadStateRevisionBuilder(db, userId),
  ] as any) as unknown as unknown[][];
  const revision = (results.at(-1) as Array<{ revision: number }> | undefined)?.[0]?.revision;
  if (revision === undefined) throw new Error("read-state revision missing");

  return {
    count: latest.length,
    revision,
  };
}

/**
 * DM sibling of `markAllServerChannelsRead`: mark every DM the viewer
 * participates in read at that DM channel's latest message. DMs are channels
 * now, so this resolves the viewer's DM channel ids (via `listDMs`) then reuses
 * the same channel mark-read path. Same invariant, monotone guard, and
 * "empty conversations are skipped" semantics.
 */
export async function markAllDmsRead(
  db: Database,
  userId: string
): Promise<ReadAllResult> {
  const dms = await listDMs(db, userId);
  const dmChannelIds = dms.map((d) => d.id);
  if (dmChannelIds.length === 0) return { count: 0, revision: null };
  return markAllServerChannelsRead(db, userId, dmChannelIds);
}

/**
 * The agent `ack` route's cursor-advance — one of two intentional writers of
 * `lastReadSeq` outside `createMessage`'s author-watermark upsert (design §4),
 * alongside notification-policy clears. Both paths advance the complete
 * read-state triple together. `Cursor = { channel, seq }` carries no message
 * id, so this first resolves
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
