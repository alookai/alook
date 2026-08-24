import { eq, and, inArray, desc, exists, lte, sql, type SQL } from "drizzle-orm";
import { communityMention, communityMessage } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, maxRowsPerInsert, D1_MAX_IN_PARAMS } from "../_chunk";
import { MENTION_KIND, type MentionKind } from "../../../constants/community";
import {
  accountReadStateRevisionBuilder,
  advanceReadStateRevisionWhenBuilder,
} from "./read-state";

// communityMention emits 5 bind params/row (id $defaultFn, message_id, user_id,
// kind default, read default), so a single INSERT caps at floor(100/5)=20 rows.
const MENTION_INSERT_MAX_ROWS = maxRowsPerInsert(5);

export async function createMentions(
  db: Database,
  data: { messageId: string; userIds: string[]; kind?: MentionKind }
) {
  if (data.userIds.length === 0) return [];

  const kind = data.kind ?? MENTION_KIND.MENTION;
  // `@everyone` expands userIds to the whole server roster — unbounded. Chunk so
  // no INSERT statement exceeds D1's 100-param limit; concat the returned rows.
  const rows = (
    await Promise.all(
      chunk(data.userIds, MENTION_INSERT_MAX_ROWS).map((batch) =>
        db
          .insert(communityMention)
          .values(
            batch.map((userId) => ({
              messageId: data.messageId,
              userId,
              kind,
            }))
          )
          .returning()
      )
    )
  ).flat();
  return rows;
}

/**
 * Return the persisted attention audience for one committed message.
 *
 * Both direct mentions and reply attention are included. Delivery planning
 * deliberately reads this fact back from D1 instead of accepting an
 * in-memory recipient hint from the route, so deferred dispatch and retries
 * use the same committed source of truth.
 */
export async function listMessageMentionUserIds(
  db: Database,
  messageId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: communityMention.userId })
    .from(communityMention)
    .where(eq(communityMention.messageId, messageId));
  return [...new Set(rows.map((row) => row.userId))];
}

export async function listUnreadMentions(
  db: Database,
  userId: string,
  opts: {
    kind?: MentionKind;
    limit?: number;
    /**
     * Scope mentions to channels the viewer may see (scope-first, in-query —
     * NOT a post-fetch filter). Closes the removed-from-private-channel leak:
     * a user @-mentioned in a private channel then removed no longer sees that
     * mention. `NULL IN (...)` is never true in SQL, so DM reply rows
     * (`channelId = NULL`) are naturally excluded — which is intended, the
     * Mentions tab does not surface DM replies. Omitted → no channel scoping
     * (callers that don't need it, e.g. a single-kind agent read).
     */
    visibleChannelIds?: string[];
  } = {}
) {
  const baseConditions = [
    eq(communityMention.userId, userId),
    eq(communityMention.read, 0),
  ];
  if (opts.kind) baseConditions.push(eq(communityMention.kind, opts.kind));

  const runQuery = (extra: ReturnType<typeof inArray>[] = []) => {
    const q = db
      .select({
        mention: communityMention,
        message: communityMessage,
        author: user,
      })
      .from(communityMention)
      .innerJoin(
        communityMessage,
        eq(communityMention.messageId, communityMessage.id)
      )
      .innerJoin(user, eq(communityMessage.authorId, user.id))
      .where(and(...baseConditions, ...extra))
      // Deterministic truncation: combining mention + reply kinds under a limit
      // needs an explicit order so the newest mentions win the cap.
      .orderBy(desc(communityMessage.createdAt));
    return opts.limit !== undefined ? q.limit(opts.limit) : q;
  };

  // No channel scoping → single query (agent single-kind read path).
  if (!opts.visibleChannelIds) {
    return runQuery();
  }
  // `NULL IN (...)` is never true, so an empty scope yields nothing — match
  // that instead of running an `inArray(col, [])` (which some drivers reject).
  if (opts.visibleChannelIds.length === 0) return [];

  // D1 caps a statement at 100 bound params. `visibleChannelIds` is an
  // unbounded authorization scope (all channels the viewer can see across every
  // server), so chunk the `inArray` and merge: each chunk runs the SAME
  // order+limit, then we re-sort by createdAt desc and re-apply the limit so the
  // global newest wins (not each chunk's newest). `message.createdAt` is in the
  // projection, so the JS re-sort is exact.
  const chunks = chunk(opts.visibleChannelIds, D1_MAX_IN_PARAMS);
  const merged = (
    await Promise.all(
      chunks.map((ids) => runQuery([inArray(communityMessage.channelId, ids)]))
    )
  ).flat();
  merged.sort((a, b) => (a.message.createdAt < b.message.createdAt ? 1 : -1));
  return opts.limit !== undefined ? merged.slice(0, opts.limit) : merged;
}

export async function markMentionsRead(
  db: Database,
  userId: string,
  messageIds: string[]
) {
  if (messageIds.length === 0) return;

  await db
    .update(communityMention)
    .set({ read: 1 })
    .where(
      and(
        eq(communityMention.userId, userId),
        inArray(communityMention.messageId, messageIds)
      )
    );
}

export async function markAllMentionsRead(db: Database, userId: string) {
  await db
    .update(communityMention)
    .set({ read: 1 })
    .where(and(eq(communityMention.userId, userId), eq(communityMention.read, 0)));
}

export async function markAllMentionsReadWithRevision(
  db: Database,
  userId: string
) {
  const unreadExists = exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityMention)
      .where(
        and(
          eq(communityMention.userId, userId),
          eq(communityMention.read, 0)
        )
      )
  );
  const mutation = db
    .update(communityMention)
    .set({ read: 1 })
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0)
      )
    );
  const results = await db.batch([
    advanceReadStateRevisionWhenBuilder(db, userId, unreadExists),
    mutation,
    accountReadStateRevisionBuilder(db, userId),
  ] as any) as unknown[];
  return {
    changed: (results[0] as Array<{ revision: number }>).length > 0,
    revision: (results[2] as Array<{ revision: number }>)[0]?.revision ?? 0,
  };
}

export async function markChannelMentionsRead(db: Database, userId: string, channelId: string) {
  const mentionIds = await db
    .select({ id: communityMention.id })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMention.messageId, communityMessage.id))
    .where(and(
      eq(communityMention.userId, userId),
      eq(communityMention.read, 0),
      eq(communityMessage.channelId, channelId)
    ));
  if (mentionIds.length === 0) return;
  await db.update(communityMention)
    .set({ read: 1 })
    .where(inArray(communityMention.id, mentionIds.map((r) => r.id)));
}

/**
 * Batch-friendly builder version of `markChannelMentionsRead`. Collapses the
 * two-step "select-ids-then-update" into a single UPDATE with a correlated
 * subquery, so it can be composed into `db.batch([...])`.
 *
 * Note: this always fires the UPDATE — even when there are no matching rows,
 * the statement is a no-op. That's fine for a batch; the batch cost is one
 * round-trip regardless.
 */
export function markChannelMentionsReadBuilder(
  db: Database,
  userId: string,
  channelId: string,
  targetSeq?: number
) {
  const matchingMentionIds = db
    .select({ id: communityMention.id })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMention.messageId, communityMessage.id))
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0),
        eq(communityMessage.channelId, channelId),
        ...(targetSeq === undefined ? [] : [lte(communityMessage.seq, targetSeq)])
      )
    );

  return db
    .update(communityMention)
    .set({ read: 1 })
    .where(inArray(communityMention.id, matchingMentionIds));
}

export function unreadChannelMentionThroughSeqCondition(
  db: Database,
  userId: string,
  channelId: string,
  targetSeq: number
): SQL<unknown> {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityMention)
      .innerJoin(
        communityMessage,
        eq(communityMention.messageId, communityMessage.id)
      )
      .where(
        and(
          eq(communityMention.userId, userId),
          eq(communityMention.read, 0),
          eq(communityMessage.channelId, channelId),
          lte(communityMessage.seq, targetSeq)
        )
      )
  );
}

export function unreadMessageMentionCondition(
  db: Database,
  userId: string,
  messageId: string
): SQL<unknown> {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityMention)
      .where(
        and(
          eq(communityMention.userId, userId),
          eq(communityMention.messageId, messageId),
          eq(communityMention.read, 0)
        )
      )
  );
}

export function markMessageMentionsReadBuilder(
  db: Database,
  userId: string,
  messageId: string
) {
  return db
    .update(communityMention)
    .set({ read: 1 })
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.messageId, messageId),
        eq(communityMention.read, 0)
      )
    );
}

/**
 * True when the given user is `@`-mentioned on the given message (`kind =
 * "mention"`). Used by wake_trigger audit rows to record `reason: "mention"`
 * vs the default `"unread"`.
 */
export async function hasMentionForMessage(
  db: Database,
  messageId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityMention.id })
    .from(communityMention)
    .where(
      and(
        eq(communityMention.messageId, messageId),
        eq(communityMention.userId, userId),
        eq(communityMention.kind, MENTION_KIND.MENTION)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function deleteMention(db: Database, userId: string, mentionId: string) {
  const rows = await db
    .delete(communityMention)
    .where(
      and(eq(communityMention.id, mentionId), eq(communityMention.userId, userId))
    )
    .returning({ id: communityMention.id });
  return rows.length;
}

export async function dismissMentionWithRevision(
  db: Database,
  userId: string,
  mentionId: string
) {
  const unreadExists = exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityMention)
      .where(
        and(
          eq(communityMention.id, mentionId),
          eq(communityMention.userId, userId),
          eq(communityMention.read, 0)
        )
      )
  );
  const mutation = db
    .delete(communityMention)
    .where(
      and(
        eq(communityMention.id, mentionId),
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0)
      )
    );
  const results = await db.batch([
    advanceReadStateRevisionWhenBuilder(db, userId, unreadExists),
    mutation,
    accountReadStateRevisionBuilder(db, userId),
  ] as any) as unknown[];
  return {
    changed: (results[0] as Array<{ revision: number }>).length > 0,
    revision: (results[2] as Array<{ revision: number }>)[0]?.revision ?? 0,
  };
}
