import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { communityChannel, communityChannelMember, communityMessageTag } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, maxRowsPerInsert, D1_MAX_IN_PARAMS } from "../_chunk";
import { type ParticipantSource } from "../../../constants/community";
import { compareAsciiSqliteBinary } from "../../../lib/sqlite-binary";

// The NOTIFICATION set for a child thread — relation='notify' rows
// on `community_channel_member` (formerly the standalone
// community_thread_participant table). A thread/post is not an access unit —
// any parent-channel member can read it — so these rows only decide who gets
// pinged / sees the unit as unread. Admins are NOT auto-included: the notify
// set is exactly these rows.
//
// There is no per-participant mute here — muting is the OUTER channel-header
// notification level, not a property of participation. Participation is
// add / leave only. A user may also hold a relation='access' row on the same
// channel; the two coexist under the (channel_id, user_id, relation) unique.

// Derived from PARTICIPANT_SOURCE (constants/community.ts) so the type and the
// literal set can never drift.
export type ThreadParticipantSource = ParticipantSource;

const NOTIFY_CONFLICT_TARGET = [
  communityChannelMember.channelId,
  communityChannelMember.userId,
  communityChannelMember.relation,
] as const;

// Idempotent add. `onConflictDoNothing` so a re-mention/re-speak of an existing
// participant is a no-op (does NOT overwrite `source`).
// Returns the inserted row, or null when the participant already existed.
export async function addThreadParticipant(
  db: Database,
  data: { threadChannelId: string; userId: string; source: ThreadParticipantSource }
) {
  const rows = await db
    .insert(communityChannelMember)
    .values({
      channelId: data.threadChannelId,
      userId: data.userId,
      relation: "notify",
      source: data.source,
    })
    .onConflictDoNothing({ target: [...NOTIFY_CONFLICT_TARGET] })
    .returning();
  return rows[0] ?? null;
}

// Bulk idempotent add — one INSERT for many (userId, source) pairs. Used on the
// message-send hot path where a post can add the author + N mentioned users at
// once. Skips the query for an empty list. Does not overwrite existing rows.
export async function addThreadParticipants(
  db: Database,
  threadChannelId: string,
  rows: { userId: string; source: ThreadParticipantSource }[]
) {
  if (rows.length === 0) return [];
  // communityChannelMember emits 6 bind params/row (id $defaultFn, channel_id,
  // user_id, relation, source, added_at $defaultFn; added_by is an unsupplied
  // literal null, not a param), so cap at floor(100/6)=16 rows for D1's 100-param
  // limit. `onConflictDoNothing` adds no VALUES params.
  const insertedUserIds: string[] = [];
  for (const batch of chunk(rows, maxRowsPerInsert(6))) {
    const inserted = await db
      .insert(communityChannelMember)
      .values(
        batch.map((r) => ({
          channelId: threadChannelId,
          userId: r.userId,
          relation: "notify",
          source: r.source,
        }))
      )
      .onConflictDoNothing({ target: [...NOTIFY_CONFLICT_TARGET] })
      .returning({ userId: communityChannelMember.userId });
    for (const row of inserted) insertedUserIds.push(row.userId);
  }
  return insertedUserIds;
}

// The NOTIFY set: every participant userId. This is what thread fan-out /
// mention rows / inbox unread scope to.
export async function listThreadParticipantUserIds(
  db: Database,
  threadChannelId: string
): Promise<string[]> {
  const rows = await db
    .select({ userId: communityChannelMember.userId })
    .from(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.relation, "notify")
      )
    );
  return rows.map((r) => r.userId);
}

// Full participant list hydrated for display — the thread's participant panel.
export async function listThreadParticipants(
  db: Database,
  threadChannelId: string
) {
  return db
    .select({
      userId: communityChannelMember.userId,
      source: communityChannelMember.source,
      addedAt: communityChannelMember.addedAt,
      userName: user.name,
      userImage: user.image,
      discriminator: user.discriminator,
    })
    .from(communityChannelMember)
    .innerJoin(user, eq(user.id, communityChannelMember.userId))
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.relation, "notify")
      )
    );
}

// Batch participant hydration for many channels at once — the forum list's
// per-card AvatarGroup. One query for N post ids instead of N. Rows carry the
// channel id so the caller can group them back per post; `addedAt` orders the
// group. Soft-deleted users drop out via the inner join.
export async function listParticipantsForChannels(
  db: Database,
  channelIds: string[],
  limitPerChannel?: number
) {
  if (channelIds.length === 0) return [];
  // D1 caps each statement at 100 bind parameters. Both variants below bind
  // every channel id plus fixed predicates (and the ranked variant also binds
  // the per-channel limit), so hydrate in safe chunks. De-duplicate first so
  // an id repeated across chunk boundaries cannot duplicate participant rows.
  const channelIdChunks = chunk([...new Set(channelIds)], D1_MAX_IN_PARAMS);
  if (limitPerChannel !== undefined) {
    const batches = await Promise.all(channelIdChunks.map((ids) => {
      const ranked = db
        .select({
          channelId: communityChannelMember.channelId,
          userId: communityChannelMember.userId,
          addedAt: communityChannelMember.addedAt,
          userName: user.name,
          userImage: user.image,
          participantCount: sql<number>`count(*) over (partition by ${communityChannelMember.channelId})`.as("participant_count"),
          rank: sql<number>`row_number() over (partition by ${communityChannelMember.channelId} order by ${communityChannelMember.addedAt}, ${communityChannelMember.userId})`.as("participant_rank"),
        })
        .from(communityChannelMember)
        .innerJoin(user, eq(user.id, communityChannelMember.userId))
        .where(and(
          inArray(communityChannelMember.channelId, ids),
          eq(communityChannelMember.relation, "notify")
        ))
        .as("ranked_participants");
      return db
        .select({
          channelId: ranked.channelId,
          userId: ranked.userId,
          addedAt: ranked.addedAt,
          userName: ranked.userName,
          userImage: ranked.userImage,
          participantCount: ranked.participantCount,
        })
        .from(ranked)
        .where(lte(ranked.rank, limitPerChannel))
        .orderBy(asc(ranked.channelId), asc(ranked.addedAt), asc(ranked.userId));
    }));
    return batches.flat().sort((a, b) =>
      compareAsciiSqliteBinary(a.channelId, b.channelId) ||
      compareAsciiSqliteBinary(a.addedAt, b.addedAt) ||
      compareAsciiSqliteBinary(a.userId, b.userId)
    );
  }
  const batches = await Promise.all(channelIdChunks.map((ids) => db
    .select({
      channelId: communityChannelMember.channelId,
      userId: communityChannelMember.userId,
      addedAt: communityChannelMember.addedAt,
      userName: user.name,
      userImage: user.image,
    })
    .from(communityChannelMember)
    .innerJoin(user, eq(user.id, communityChannelMember.userId))
    .where(
      and(
        inArray(communityChannelMember.channelId, ids),
        eq(communityChannelMember.relation, "notify")
      )
    )));
  return batches.flat();
}

export async function isThreadParticipant(
  db: Database,
  threadChannelId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityChannelMember.id })
    .from(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "notify")
      )
    )
    .limit(1);
  return rows.length > 0;
}

// Leave: drop the notify row entirely (a later mention/speak re-adds). Returns
// the removed row or null.
export async function removeThreadParticipant(
  db: Database,
  threadChannelId: string,
  userId: string
) {
  const rows = await db
    .delete(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "notify")
      )
    )
    .returning();
  return rows[0] ?? null;
}

// Drop a user's notify rows from EVERY child thread
// under a top-level unit. Called when a member is removed from a forum/channel's
// access roster: their access is gone, so their leftover notify rows on the
// unit's posts/threads must go too. A later mention/speak (which requires
// access) re-adds them. Returns the count of removed rows.
export async function removeParticipantFromChildChannels(
  db: Database,
  parentChannelId: string,
  userId: string
): Promise<number> {
  const children = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(eq(communityChannel.parentChannelId, parentChannelId));
  const childIds = children.map((c) => c.id);
  if (childIds.length === 0) return 0;
  const removed = await db
    .delete(communityChannelMember)
    .where(
      and(
        inArray(communityChannelMember.channelId, childIds),
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "notify")
      )
    )
    .returning();
  return removed.length;
}

// Of the given thread ids, which the user participates in (notify). Batch form
// for the inbox unread-threads filter.
export async function listParticipatingThreadIds(
  db: Database,
  threadChannelIds: string[],
  userId: string
): Promise<string[]> {
  if (threadChannelIds.length === 0) return [];
  // Chunk the `inArray` for D1's 100-param limit; no order/limit → concat.
  const rows = (
    await Promise.all(
      chunk(threadChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({ channelId: communityChannelMember.channelId })
          .from(communityChannelMember)
          .where(
            and(
              inArray(communityChannelMember.channelId, ids),
              eq(communityChannelMember.userId, userId),
              eq(communityChannelMember.relation, "notify")
            )
          )
      )
    )
  ).flat();
  return rows.map((r) => r.channelId);
}

export type ForumCreatedAtCursor = { createdAt: string; id: string };

export async function listForumThreadsByCreatedAt(
  db: Database,
  params: {
    parentChannelId: string;
    tag?: string;
    cursor?: ForumCreatedAtCursor;
    limit: number;
  }
) {
  const activityAt = sql<string>`coalesce(${communityChannel.lastMessageAt}, ${communityChannel.createdAt})`;
  const conditions = [
    eq(communityChannel.parentChannelId, params.parentChannelId),
    eq(communityChannel.type, "thread"),
    eq(communityChannel.archived, 0),
    isNotNull(communityChannel.parentMessageId),
  ];
  if (params.cursor) {
    conditions.push(or(
      lt(communityChannel.createdAt, params.cursor.createdAt),
      and(
        eq(communityChannel.createdAt, params.cursor.createdAt),
        lt(communityChannel.id, params.cursor.id)
      )
    )!);
  }

  const select = {
    id: communityChannel.id,
    serverId: communityChannel.serverId,
    categoryId: communityChannel.categoryId,
    name: communityChannel.name,
    type: communityChannel.type,
    topic: communityChannel.topic,
    position: communityChannel.position,
    parentChannelId: communityChannel.parentChannelId,
    creatorId: communityChannel.creatorId,
    messageCount: communityChannel.messageCount,
    archived: communityChannel.archived,
    parentMessageId: communityChannel.parentMessageId,
    lastMessageAt: communityChannel.lastMessageAt,
    createdAt: communityChannel.createdAt,
    activityAt: activityAt.as("activity_at"),
  } as const;

  if (params.tag) {
    return db
      .select(select)
      .from(communityChannel)
      .innerJoin(
        communityMessageTag,
        and(
          eq(communityMessageTag.messageId, communityChannel.parentMessageId),
          eq(communityMessageTag.tag, params.tag)
        )
      )
      .where(and(...conditions))
      .orderBy(desc(communityChannel.createdAt), desc(communityChannel.id))
      .limit(params.limit);
  }

  return db
    .select(select)
    .from(communityChannel)
    .where(and(...conditions))
    .orderBy(desc(communityChannel.createdAt), desc(communityChannel.id))
    .limit(params.limit);
}

/**
 * Viewer-participating forum posts for the nested server sidebar. The caller
 * supplies only forum ids that already passed the viewer's top-level visibility
 * gate; notify membership narrows that trusted set to posts the viewer follows.
 * The rolling activity window and row_number limit are applied per forum in SQL.
 *
 * `retainId` is the currently open post. If it is a valid participating post
 * under one of the visible forums, keep it even outside the rolling window or
 * top-N and let it displace that forum's final ordinary row.
 */
export async function listParticipatingForumThreads(
  db: Database,
  params: {
    parentChannelIds: string[];
    userId: string;
    activeAfter: string;
    limitPerParent: number;
    retainId?: string;
  }
) {
  const parentChannelIds = [...new Set(params.parentChannelIds)];
  if (parentChannelIds.length === 0 || params.limitPerParent < 1) {
    return { canonical: [], retained: null };
  }

  const activityAt = sql<string>`coalesce(${communityChannel.lastMessageAt}, ${communityChannel.createdAt})`;
  const select = {
    id: communityChannel.id,
    serverId: communityChannel.serverId,
    categoryId: communityChannel.categoryId,
    name: communityChannel.name,
    type: communityChannel.type,
    topic: communityChannel.topic,
    position: communityChannel.position,
    parentChannelId: communityChannel.parentChannelId,
    creatorId: communityChannel.creatorId,
    messageCount: communityChannel.messageCount,
    archived: communityChannel.archived,
    parentMessageId: communityChannel.parentMessageId,
    lastMessageAt: communityChannel.lastMessageAt,
    createdAt: communityChannel.createdAt,
    activityAt: activityAt.as("activity_at"),
  } as const;

  const batches = await Promise.all(
    chunk(parentChannelIds, D1_MAX_IN_PARAMS).map((parentIds) => {
      const ranked = db
        .select({
          ...select,
          rank: sql<number>`row_number() over (partition by ${communityChannel.parentChannelId} order by ${activityAt} desc, ${communityChannel.id} desc)`.as("sidebar_rank"),
        })
        .from(communityChannel)
        .innerJoin(
          communityChannelMember,
          and(
            eq(communityChannelMember.channelId, communityChannel.id),
            eq(communityChannelMember.userId, params.userId),
            eq(communityChannelMember.relation, "notify"),
          ),
        )
        .where(and(
          inArray(communityChannel.parentChannelId, parentIds),
          eq(communityChannel.type, "thread"),
          eq(communityChannel.archived, 0),
          isNotNull(communityChannel.parentMessageId),
          gt(activityAt, params.activeAfter),
        ))
        .as("ranked_sidebar_threads");

      return db
        .select({
          id: ranked.id,
          serverId: ranked.serverId,
          categoryId: ranked.categoryId,
          name: ranked.name,
          type: ranked.type,
          topic: ranked.topic,
          position: ranked.position,
          parentChannelId: ranked.parentChannelId,
          creatorId: ranked.creatorId,
          messageCount: ranked.messageCount,
          archived: ranked.archived,
          parentMessageId: ranked.parentMessageId,
          lastMessageAt: ranked.lastMessageAt,
          createdAt: ranked.createdAt,
          activityAt: ranked.activityAt,
        })
        .from(ranked)
        .where(lte(ranked.rank, params.limitPerParent))
        .orderBy(asc(ranked.parentChannelId), desc(ranked.activityAt), desc(ranked.id));
    }),
  );
  const rows = batches.flat();
  let retained: (typeof rows)[number] | null = null;

  if (params.retainId) {
    // Scope the retained lookup inside the same caller-authorized parent set,
    // rather than fetching an arbitrary id first and masking it in JS. Chunking
    // preserves that structural scope without exceeding D1's bind ceiling.
    retained = (await Promise.all(
      chunk(parentChannelIds, D1_MAX_IN_PARAMS).map((parentIds) => db
        .select(select)
        .from(communityChannel)
        .innerJoin(
          communityChannelMember,
          and(
            eq(communityChannelMember.channelId, communityChannel.id),
            eq(communityChannelMember.userId, params.userId),
            eq(communityChannelMember.relation, "notify"),
          ),
        )
        .where(and(
          eq(communityChannel.id, params.retainId!),
          inArray(communityChannel.parentChannelId, parentIds),
          eq(communityChannel.type, "thread"),
          eq(communityChannel.archived, 0),
          isNotNull(communityChannel.parentMessageId),
        ))
        .limit(1)),
    )).flat()[0] ?? null;
  }

  return {
    canonical: rows.sort((a, b) =>
      compareAsciiSqliteBinary(a.parentChannelId ?? "", b.parentChannelId ?? "") ||
      compareAsciiSqliteBinary(b.activityAt, a.activityAt) ||
      compareAsciiSqliteBinary(b.id, a.id)
    ),
    retained,
  };
}
