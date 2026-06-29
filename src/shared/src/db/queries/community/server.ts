import { eq, and, asc, inArray } from "drizzle-orm";
import {
  communityServer,
  communityCategory,
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";

export async function createServer(
  db: Database,
  data: { name: string; description?: string; ownerId: string }
) {
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

  await db.insert(communityServerMember).values({
    serverId: server!.id,
    userId: data.ownerId,
    role: "owner",
    railOrder: 0,
  });

  return server!;
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
    })
    .from(communityServer)
    .innerJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityServer.id),
        eq(communityServerMember.userId, userId)
      )
    )
    .orderBy(asc(communityServerMember.railOrder));
}

export async function getServersByIds(db: Database, serverIds: string[]) {
  if (serverIds.length === 0) return [];
  return db.select().from(communityServer).where(inArray(communityServer.id, serverIds));
}
