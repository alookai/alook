import { asc, eq, and, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  communityChannelMember,
  communityReaction,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, maxInParams } from "../_chunk";

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

export async function getReactionDetailsActors(
  db: Database,
  messageId: string,
  scope: ReactionDetailsScope
): Promise<ReactionDetailsActor[]> {
  const actor = alias(user, scope.kind === "server" ? "server_reaction_actor" : "dm_reaction_actor");
  const owner = alias(user, scope.kind === "server" ? "server_reaction_owner" : "dm_reaction_owner");

  if (scope.kind === "server") {
    const eligible = db
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
      .as("eligible_server_reaction_actor");

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
      .where(eq(communityReaction.messageId, messageId))
      .orderBy(asc(communityReaction.userId));
    return mapReactionActors(rows);
  }

  const eligible = db
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
    .where(eq(communityReaction.messageId, messageId))
    .orderBy(asc(communityReaction.userId));
  return mapReactionActors(rows);
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

export async function getMessageReactions(db: Database, messageId: string) {
  return db
    .select()
    .from(communityReaction)
    .where(eq(communityReaction.messageId, messageId));
}

export async function listReactionsByMessageIds(
  db: Database,
  messageIds: string[],
  _currentUserId: string
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
