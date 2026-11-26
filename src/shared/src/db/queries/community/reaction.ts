import { asc, eq, and, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  communityChannelMember,
  communityReaction,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, maxInParams } from "../_chunk";
import { jsonTextSet } from "../_json-set";

export const DEFAULT_REACTION_ACTORS_LIMIT = 100;
export const MAX_REACTION_ACTORS_LIMIT = 200;
export const DEFAULT_REACTION_SAMPLE_LIMIT = 10;

export type ReactionDetailsScope =
  | { kind: "server"; serverId: string; channelId: string }
  | { kind: "dm"; channelId: string };

export type ReactionDetailsActor = {
  userId: string;
  profile: null | {
    id: string;
    name: string;
    discriminator: string;
    image: string | null;
    avatarVersion: number;
  };
};

function mapReactionActors(rows: Array<{
  userId: string;
  id: string | null;
  name: string | null;
  discriminator: string | null;
  image: string | null;
  avatarVersion: number | null;
}>): ReactionDetailsActor[] {
  return rows.map((row) => ({
    userId: row.userId,
    profile: row.id && row.name !== null && row.discriminator !== null
      && row.avatarVersion !== null
      ? {
          id: row.id,
          name: row.name,
          discriminator: row.discriminator,
          image: row.image,
          avatarVersion: row.avatarVersion,
        }
      : null,
  }));
}

export type ReactionDetailsActorsPage = {
  actors: ReactionDetailsActor[];
  hasMore: boolean;
  cursor: string | null;
};

function parseEmojiCursor(cursor: string | undefined): { createdAt: string; userId: string } | null {
  if (!cursor) return null;
  const separator = cursor.indexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) return null;
  return {
    createdAt: cursor.slice(0, separator),
    userId: cursor.slice(separator + 1),
  };
}

export async function getReactionDetailsActorsPage(
  db: Database,
  messageId: string,
  scope: ReactionDetailsScope,
  opts?: { emoji?: string; limit?: number; cursor?: string }
): Promise<ReactionDetailsActorsPage> {
  const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_REACTION_ACTORS_LIMIT, MAX_REACTION_ACTORS_LIMIT));
  const actor = alias(user, scope.kind === "server" ? "server_reaction_actor" : "dm_reaction_actor");
  const owner = alias(user, scope.kind === "server" ? "server_reaction_owner" : "dm_reaction_owner");

  const eligible = scope.kind === "server"
    ? db
        .select({
          id: actor.id,
          name: actor.name,
          discriminator: actor.discriminator,
          image: actor.image,
          avatarVersion: actor.avatarVersion,
        })
        .from(actor)
        .innerJoin(
          communityServerMember,
          and(
            eq(communityServerMember.userId, actor.id),
            eq(communityServerMember.serverId, scope.serverId)
          )
        )
        .leftJoin(
          owner,
          and(eq(owner.id, actor.ownerUserId), isNull(owner.deletedAt))
        )
        .where(and(
          isNull(actor.deletedAt),
          or(eq(actor.isBot, false), isNotNull(owner.id))
        ))
        .as("eligible_server_reaction_actor")
    : db
        .select({
          id: actor.id,
          name: actor.name,
          discriminator: actor.discriminator,
          image: actor.image,
          avatarVersion: actor.avatarVersion,
        })
        .from(actor)
        .innerJoin(
          communityChannelMember,
          and(
            eq(communityChannelMember.userId, actor.id),
            eq(communityChannelMember.channelId, scope.channelId),
            eq(communityChannelMember.relation, "access")
          )
        )
        .leftJoin(
          owner,
          and(eq(owner.id, actor.ownerUserId), isNull(owner.deletedAt))
        )
        .where(and(
          isNull(actor.deletedAt),
          or(eq(actor.isBot, false), isNotNull(owner.id))
        ))
        .as("eligible_dm_reaction_actor");

  if (opts?.emoji) {
    const emojiCursor = parseEmojiCursor(opts.cursor);
    const conditions = [
      eq(communityReaction.messageId, messageId),
      eq(communityReaction.emoji, opts.emoji),
    ];
    if (emojiCursor) {
      conditions.push(
        or(
          gt(communityReaction.createdAt, emojiCursor.createdAt),
          and(
            eq(communityReaction.createdAt, emojiCursor.createdAt),
            gt(communityReaction.userId, emojiCursor.userId),
          ),
        )!,
      );
    }
    const rows = await db
      .select({
        userId: communityReaction.userId,
        createdAt: communityReaction.createdAt,
        id: eligible.id,
        name: eligible.name,
        discriminator: eligible.discriminator,
        image: eligible.image,
        avatarVersion: eligible.avatarVersion,
      })
      .from(communityReaction)
      .leftJoin(eligible, eq(eligible.id, communityReaction.userId))
      .where(and(...conditions))
      .orderBy(asc(communityReaction.createdAt), asc(communityReaction.userId))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      actors: mapReactionActors(pageRows),
      hasMore,
      cursor: hasMore && last ? `${last.createdAt}|${last.userId}` : null,
    };
  }

  const conditions = [eq(communityReaction.messageId, messageId)];
  if (opts?.cursor) {
    conditions.push(gt(communityReaction.userId, opts.cursor));
  }
  const rows = await db
    .selectDistinct({
      userId: communityReaction.userId,
      id: eligible.id,
      name: eligible.name,
      discriminator: eligible.discriminator,
      image: eligible.image,
      avatarVersion: eligible.avatarVersion,
    })
    .from(communityReaction)
    .leftJoin(eligible, eq(eligible.id, communityReaction.userId))
    .where(and(...conditions))
    .orderBy(asc(communityReaction.userId))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    actors: mapReactionActors(pageRows),
    hasMore,
    cursor: hasMore && last ? last.userId : null,
  };
}

export async function getReactionDetailsActors(
  db: Database,
  messageId: string,
  scope: ReactionDetailsScope,
  opts?: { emoji?: string; limit?: number; cursor?: string }
): Promise<ReactionDetailsActor[]> {
  const page = await getReactionDetailsActorsPage(db, messageId, scope, opts);
  return page.actors;
}

export async function addReaction(
  db: Database,
  data: { messageId: string; userId: string; emoji: string }
) {
  const [row] = await db
    .insert(communityReaction)
    .values({
      messageId: data.messageId,
      userId: data.userId,
      emoji: data.emoji,
    })
    .returning();
  return row!;
}

export async function removeReaction(
  db: Database,
  data: { messageId: string; userId: string; emoji: string }
) {
  const [deleted] = await db
    .delete(communityReaction)
    .where(
      and(
        eq(communityReaction.messageId, data.messageId),
        eq(communityReaction.userId, data.userId),
        eq(communityReaction.emoji, data.emoji)
      )
    )
    .returning();
  return deleted ?? null;
}

export async function listReactionsByMessageIds(
  db: Database,
  messageIds: string[]
) {
  if (messageIds.length === 0) return [];
  return (
    await Promise.all(
      chunk([...new Set(messageIds)], maxInParams(0)).map((ids) =>
        db
          .select()
          .from(communityReaction)
          .where(inArray(communityReaction.messageId, ids))
      )
    )
  ).flat();
}

export type SummarizedReaction = {
  emoji: string;
  count: number;
  me: boolean;
  userIds: string[];
};

export async function summarizeReactionsByMessageIds(
  db: Database,
  messageIds: readonly string[],
  viewerId: string,
  sampleLimit = DEFAULT_REACTION_SAMPLE_LIMIT,
): Promise<Record<string, SummarizedReaction[]>> {
  const uniqueIds = [...new Set(messageIds.filter((id) => id.length > 0))];
  if (uniqueIds.length === 0) return {};
  const boundedSample = Math.max(1, Math.min(sampleLimit, DEFAULT_REACTION_SAMPLE_LIMIT));

  const ranked = db
    .select({
      messageId: communityReaction.messageId,
      emoji: communityReaction.emoji,
      userId: communityReaction.userId,
      rank: sql<number>`row_number() over (partition by ${communityReaction.messageId}, ${communityReaction.emoji} order by ${communityReaction.createdAt} asc, ${communityReaction.userId} asc)`.as("reaction_rank"),
    })
    .from(communityReaction)
    .where(inArray(communityReaction.messageId, jsonTextSet(db, uniqueIds)))
    .as("ranked_reactions");

  const [aggRows, sampleRows] = await Promise.all([
    db
      .select({
        messageId: communityReaction.messageId,
        emoji: communityReaction.emoji,
        count: sql<number>`COUNT(*)`.mapWith(Number),
        me: sql<number>`MAX(CASE WHEN ${communityReaction.userId} = ${viewerId} THEN 1 ELSE 0 END)`.mapWith(Number),
      })
      .from(communityReaction)
      .where(inArray(communityReaction.messageId, jsonTextSet(db, uniqueIds)))
      .groupBy(communityReaction.messageId, communityReaction.emoji)
      .orderBy(
        asc(communityReaction.messageId),
        sql`MIN(${communityReaction.createdAt})`,
        asc(communityReaction.emoji),
      ),
    db
      .select({
        messageId: ranked.messageId,
        emoji: ranked.emoji,
        userId: ranked.userId,
      })
      .from(ranked)
      .where(lte(ranked.rank, boundedSample)),
  ]);

  const sampleMap = new Map<string, string[]>();
  for (const row of sampleRows) {
    const key = `${row.messageId}\u0000${row.emoji}`;
    let list = sampleMap.get(key);
    if (!list) {
      list = [];
      sampleMap.set(key, list);
    }
    list.push(row.userId);
  }

  const out: Record<string, SummarizedReaction[]> = {};
  for (const row of aggRows) {
    const key = `${row.messageId}\u0000${row.emoji}`;
    const userIds = sampleMap.get(key) ?? [];
    const me = Boolean(row.me);
    if (me && viewerId && !userIds.includes(viewerId)) {
      if (userIds.length >= boundedSample) {
        userIds[userIds.length - 1] = viewerId;
      } else {
        userIds.push(viewerId);
      }
    }
    (out[row.messageId] ??= []).push({
      emoji: row.emoji,
      count: row.count,
      me,
      userIds,
    });
  }
  return out;
}
