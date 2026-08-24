import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  communityChannel,
  communityForumOpenerRead,
  communityMessage,
  communityReadState,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export function forumOpenerNeedsSparseReadCondition(
  db: Database,
  userId: string,
  openerMessageId: string
): SQL<unknown> {
  const candidate = db
    .select({ one: sql<number>`1` })
    .from(communityMessage)
    .innerJoin(
      communityChannel,
      eq(communityChannel.id, communityMessage.channelId)
    )
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityChannel.serverId),
        eq(communityServerMember.userId, userId)
      )
    )
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.userId, userId),
        eq(communityReadState.channelId, communityChannel.id)
      )
    )
    .where(
      and(
        eq(communityMessage.id, openerMessageId),
        eq(communityChannel.type, "forum"),
        isNull(communityChannel.parentChannelId),
        or(
          and(
            isNotNull(communityReadState.id),
            gt(communityMessage.seq, communityReadState.lastReadSeq)
          ),
          and(
            isNull(communityReadState.id),
            gt(communityMessage.createdAt, communityServerMember.joinedAt)
          )
        ),
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(communityForumOpenerRead)
            .where(
              and(
                eq(communityForumOpenerRead.userId, userId),
                eq(communityForumOpenerRead.openerMessageId, openerMessageId)
              )
            )
        )
      )
    );
  return exists(candidate);
}

export function markForumOpenerReadBuilder(
  db: Database,
  data: {
    userId: string;
    openerMessageId: string;
    readAt: string;
    condition?: SQL<unknown>;
  }
) {
  const condition = data.condition ?? forumOpenerNeedsSparseReadCondition(
    db,
    data.userId,
    data.openerMessageId
  );
  const selected = db
    .select({
      userId: sql<string>`${data.userId}`.as("user_id"),
      openerMessageId: sql<string>`${data.openerMessageId}`.as("opener_message_id"),
      readAt: sql<string>`${data.readAt}`.as("read_at"),
    })
    .from(user)
    .where(and(eq(user.id, data.userId), condition));
  return db
    .insert(communityForumOpenerRead)
    .select(selected)
    .onConflictDoNothing();
}

export function hasForumOpenerReadCondition(
  db: Database,
  userId: string,
  openerMessageId: string
): SQL<unknown> {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityForumOpenerRead)
      .where(
        and(
          eq(communityForumOpenerRead.userId, userId),
          eq(communityForumOpenerRead.openerMessageId, openerMessageId)
        )
      )
  );
}

function coveredForumOpenerIds(
  db: Database,
  data: { channelId: string; targetSeq: number }
) {
  return db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .innerJoin(
      communityChannel,
      eq(communityChannel.id, communityMessage.channelId)
    )
    .where(
      and(
        eq(communityChannel.id, data.channelId),
        eq(communityChannel.type, "forum"),
        isNull(communityChannel.parentChannelId),
        lte(communityMessage.seq, data.targetSeq)
      )
    );
}

export function coveredForumOpenerReadExistsCondition(
  db: Database,
  data: { userId: string; channelId: string; targetSeq: number }
): SQL<unknown> {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(communityForumOpenerRead)
      .where(
        and(
          eq(communityForumOpenerRead.userId, data.userId),
          inArray(
            communityForumOpenerRead.openerMessageId,
            coveredForumOpenerIds(db, data)
          )
        )
      )
  );
}

export function pruneCoveredForumOpenerReadsBuilder(
  db: Database,
  data: { userId: string; channelId: string; targetSeq: number }
) {
  return db
    .delete(communityForumOpenerRead)
    .where(
      and(
        eq(communityForumOpenerRead.userId, data.userId),
        inArray(
          communityForumOpenerRead.openerMessageId,
          coveredForumOpenerIds(db, data)
        )
      )
    );
}
