import { eq, and, inArray, desc, exists, lte, sql, type SQL } from "drizzle-orm";
import { communityChannel, communityMention, communityMessage } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import { MENTION_KIND, type MentionKind } from "../../../constants/community";
import {
  accountReadStateRevisionBuilder,
  advanceReadStateRevisionWhenBuilder,
} from "./read-state";

export async function listMessageAttentionTargets(
  db: Database,
  messageId: string,
): Promise<Array<{ userId: string; kind: MentionKind }>> {
  const rows = await db
    .select({ userId: communityMention.userId, kind: communityMention.kind })
    .from(communityMention)
    .where(eq(communityMention.messageId, messageId));
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.userId}:${row.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => ({ ...row, kind: row.kind as MentionKind }));
}

export async function listUnreadMentions(
  db: Database,
  userId: string,
  opts: {
    limit?: number;
    visibleChannelIds: string[];
  }
) {
  const baseConditions = [
    eq(communityMention.userId, userId),
    eq(communityMention.read, 0),
  ];

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

export async function listUnreadMentionScopes(
  db: Database,
  userId: string,
  visibleChannelIds: string[],
) {
  if (visibleChannelIds.length === 0) return [];
  return (
    await Promise.all(
      chunk(visibleChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            channelId: communityChannel.id,
            serverId: communityChannel.serverId,
            parentChannelId: communityChannel.parentChannelId,
            attentionCount: sql<number>`COUNT(*)`.mapWith(Number),
            lastAttentionSeq: sql<number>`MAX(${communityMessage.seq})`.mapWith(Number),
          })
          .from(communityMention)
          .innerJoin(
            communityMessage,
            eq(communityMention.messageId, communityMessage.id),
          )
          .innerJoin(
            communityChannel,
            eq(communityMessage.channelId, communityChannel.id),
          )
          .where(and(
            eq(communityMention.userId, userId),
            eq(communityMention.read, 0),
            inArray(communityChannel.id, ids),
          ))
          .groupBy(communityChannel.id)
      )
    )
  ).flat();
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
  targetSeq?: number,
  guard?: SQL<unknown>,
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
    .where(and(
      inArray(communityMention.id, matchingMentionIds),
      ...(guard ? [guard] : []),
    ));
}

export function unreadChannelMentionThroughSeqCondition(
  db: Database,
  userId: string,
  channelId: string,
  targetSeq: number,
  guard?: SQL<unknown>,
): SQL<unknown> {
  const unreadExists = exists(
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
  return guard ? and(guard, unreadExists)! : unreadExists;
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
