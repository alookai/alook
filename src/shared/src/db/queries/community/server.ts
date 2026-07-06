import { eq, and, asc, inArray, sql, count } from "drizzle-orm";
import {
  communityServer,
  communityCategory,
  communityChannel,
  communityServerMember,
  communityMention,
  communityMessage,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function createServer(
  db: Database,
  data: { name: string; description?: string; ownerId: string }
): Promise<{
  server: typeof communityServer.$inferSelect;
  ownerMember: {
    id: string;
    userId: string;
    joinedAt: string;
    userName: string;
    userImage: string | null;
  };
}> {
  const [server] = await db
    .insert(communityServer)
    .values({
      name: data.name,
      description: data.description ?? "",
      ownerId: data.ownerId,
    })
    .returning();

  const [category] = await db
    .insert(communityCategory)
    .values({
      serverId: server!.id,
      name: "Text Channels",
      position: 0,
    })
    .returning();

  await db.insert(communityChannel).values({
    serverId: server!.id,
    categoryId: category!.id,
    name: "general",
    type: "text",
    position: 0,
  });

  const [memberRow] = await db
    .insert(communityServerMember)
    .values({
      serverId: server!.id,
      userId: data.ownerId,
      role: "owner",
      railOrder: 0,
    })
    .returning({
      id: communityServerMember.id,
      userId: communityServerMember.userId,
      joinedAt: communityServerMember.joinedAt,
    });

  // Fetch the owner's display name + avatar directly instead of re-listing
  // members — a freshly-created server has exactly one member row, so a
  // scoped select is honest about intent and avoids `.find` disambiguation
  // in the caller.
  const [userRow] = await db
    .select({ name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, data.ownerId));

  return {
    server: server!,
    ownerMember: {
      id: memberRow!.id,
      userId: memberRow!.userId,
      joinedAt: memberRow!.joinedAt,
      // user.name is kept non-empty by the Better-Auth create.before hook
      // and the createUser/updateUser guards — the `?? ""` is defensive.
      userName: userRow?.name ?? "",
      userImage: userRow?.image ?? null,
    },
  };
}

export async function getServer(db: Database, serverId: string) {
  const rows = await db
    .select()
    .from(communityServer)
    .where(eq(communityServer.id, serverId));
  return rows[0] ?? null;
}

export async function updateServer(
  db: Database,
  serverId: string,
  data: { name?: string; description?: string; icon?: string }
) {
  const rows = await db
    .update(communityServer)
    .set(data)
    .where(eq(communityServer.id, serverId))
    .returning();
  return rows[0] ?? null;
}

export async function deleteServer(db: Database, serverId: string) {
  const rows = await db
    .delete(communityServer)
    .where(eq(communityServer.id, serverId))
    .returning();
  return rows[0] ?? null;
}

export async function listUserServers(db: Database, userId: string) {
  // Subquery: unread mention count for this viewer, grouped by server.
  // Only kind='mention' counts toward the rail badge — replies live in the
  // For You feed but do not warrant a red number on the server icon.
  // The inner joins on message → channel drop DM mentions (channelId IS NULL)
  // and orphan rows, so the count only reflects server-scoped mentions.
  const mentionCounts = db
    .select({
      serverId: communityChannel.serverId,
      mentions: count().as("mentions"),
    })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMessage.id, communityMention.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0),
        eq(communityMention.kind, "mention")
      )
    )
    .groupBy(communityChannel.serverId)
    .as("mention_counts");

  return db
    .select({
      id: communityServer.id,
      name: communityServer.name,
      description: communityServer.description,
      icon: communityServer.icon,
      ownerId: communityServer.ownerId,
      createdAt: communityServer.createdAt,
      role: communityServerMember.role,
      nickname: communityServerMember.nickname,
      railOrder: communityServerMember.railOrder,
      // COALESCE has no ORM operator in this Drizzle version — the LEFT JOIN
      // yields NULL for servers with zero unread mentions. Wrap the aggregate
      // column with a narrow `sql` cast so the client always receives a
      // number, never NULL.
      mentions: sql<number>`COALESCE(${mentionCounts.mentions}, 0)`.mapWith(Number),
    })
    .from(communityServer)
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityServer.id),
        eq(communityServerMember.userId, userId)
      )
    )
    .leftJoin(mentionCounts, eq(mentionCounts.serverId, communityServer.id))
    .orderBy(asc(communityServerMember.railOrder));
}

export async function getServersByIds(db: Database, serverIds: string[]) {
  if (serverIds.length === 0) return [];
  return db.select().from(communityServer).where(inArray(communityServer.id, serverIds));
}

export async function setServerIcon(
  db: Database,
  serverId: string,
  icon: string | null,
) {
  await db
    .update(communityServer)
    .set({ icon })
    .where(eq(communityServer.id, serverId));
}
