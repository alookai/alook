import { eq, and, asc, inArray, sql, count } from "drizzle-orm";
import {
  communityServer,
  communityCategory,
  communityChannel,
  communityChannelMember,
  communityServerMember,
  communityMention,
  communityMessage,
  communityReadState,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { nanoid } from "nanoid";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import { MENTION_KIND } from "../../../constants/community";
import { withUniqueDiscriminator } from "../user";
import { parseNameAndTag } from "../../../lib/discriminator";
import { notificationEligibleSql } from "./notification-eligibility";
import { channelReadableSql } from "./channel";

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
    userDiscriminator: string;
  };
}> {
  // Mint the id up-front so the discriminator (an FNV-1a hash of the id) is
  // written in the same INSERT — same pattern as createUser/createBot. Only the
  // server row carries the discriminator, so wrap just that insert (not the
  // whole batch): category/channel/member rows don't touch the (name,
  // discriminator) unique index, so they run after the server row wins its
  // discriminator. A collision against idx_community_server_name_discriminator
  // salt-retries the server insert; throw-at-cap on exhaustion (loud, never a
  // silent duplicate).
  const id = nanoid();
  const server = await withUniqueDiscriminator(
    db,
    { id, name: data.name },
    async (discriminator) => {
      const [row] = await db
        .insert(communityServer)
        .values({
          id,
          name: data.name,
          discriminator,
          description: data.description ?? "",
          ownerId: data.ownerId,
        })
        .returning();
      return row!;
    }
  );

  const [publicCategory] = await db
    .insert(communityCategory)
    .values({
      serverId: server.id,
      name: "Public",
      position: 0,
      private: 0,
    })
    .returning();

  await db.insert(communityChannel).values({
    serverId: server.id,
    categoryId: publicCategory!.id,
    name: "all",
    type: "text",
    position: 0,
  });

  const [privateCategory] = await db
    .insert(communityCategory)
    .values({
      serverId: server.id,
      name: "Private",
      position: 1,
      private: 1,
      creatorId: data.ownerId,
    })
    .returning();

  const [privateChannel] = await db
    .insert(communityChannel)
    .values({
      serverId: server.id,
      categoryId: privateCategory!.id,
      name: "room",
      type: "text",
      position: 0,
      creatorId: data.ownerId,
    })
    .returning();

  await db.insert(communityChannelMember).values({
    channelId: privateChannel!.id,
    userId: data.ownerId,
    relation: "access",
    source: "added",
    addedBy: data.ownerId,
  });

  const [memberRow] = await db
    .insert(communityServerMember)
    .values({
      serverId: server.id,
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
    .select({ name: user.name, image: user.image, discriminator: user.discriminator })
    .from(user)
    .where(eq(user.id, data.ownerId));

  return {
    server,
    ownerMember: {
      id: memberRow!.id,
      userId: memberRow!.userId,
      joinedAt: memberRow!.joinedAt,
      // user.name is kept non-empty by the Better-Auth create.before hook
      // and the createUser/updateUser guards — the `?? ""` is defensive.
      userName: userRow?.name ?? "",
      userImage: userRow?.image ?? null,
      // NOT NULL column; `?? "0000"` mirrors the schema default defensively.
      userDiscriminator: userRow?.discriminator ?? "0000",
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
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.userId, userId),
        eq(communityReadState.channelId, communityChannel.id)
      )
    )
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0),
        eq(communityMention.kind, MENTION_KIND.MENTION),
        sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
        channelReadableSql(userId, {
          id: communityChannel.id,
          type: communityChannel.type,
          serverId: communityChannel.serverId,
          parentChannelId: communityChannel.parentChannelId,
        }),
        notificationEligibleSql(
          userId,
          {
            id: communityChannel.id,
            serverId: communityChannel.serverId,
            parentChannelId: communityChannel.parentChannelId,
          },
          { id: communityMessage.id }
        )
      )
    )
    .groupBy(communityChannel.serverId)
    .as("mention_counts");

  return db
    .select({
      id: communityServer.id,
      name: communityServer.name,
      discriminator: communityServer.discriminator,
      description: communityServer.description,
      icon: communityServer.icon,
      ownerId: communityServer.ownerId,
      createdAt: communityServer.createdAt,
      role: communityServerMember.role,
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

/**
 * Resolve a server by unique handle, scoped to servers
 * `userId` is a member of.
 * Returns an ARRAY — the caller decides what "ambiguous" means (0 = not
 * found/not a member, 1 = resolved). Bare names are not an address.
 */
export async function resolveServerByNameForMember(
  db: Database,
  userId: string,
  handleRef: string
) {
  const handle = parseNameAndTag(handleRef);
  if (handle) {
    return db
      .select({
        id: communityServer.id,
        name: communityServer.name,
        discriminator: communityServer.discriminator,
      })
      .from(communityServer)
      .innerJoin(
        communityServerMember,
        and(
          eq(communityServerMember.serverId, communityServer.id),
          eq(communityServerMember.userId, userId)
        )
      )
      .where(
        and(
          sql`${communityServer.name} COLLATE NOCASE = ${handle.name}`,
          eq(communityServer.discriminator, handle.discriminator)
        )
      );
  }

  return [];
}

export async function getServersByIds(db: Database, serverIds: string[]) {
  if (serverIds.length === 0) return [];
  // Chunk the `inArray` for D1's 100-param limit (mentions hydration can pass a
  // page's worth of distinct server ids); no order/limit → concat.
  return (
    await Promise.all(
      chunk(serverIds, D1_MAX_IN_PARAMS).map((ids) =>
        db.select().from(communityServer).where(inArray(communityServer.id, ids))
      )
    )
  ).flat();
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
