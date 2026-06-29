import { eq, and, ne, inArray } from "drizzle-orm";
import { communityServerMember } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function addMember(
  db: Database,
  data: { serverId: string; userId: string; role?: string }
) {
  const rows = await db
    .insert(communityServerMember)
    .values({
      serverId: data.serverId,
      userId: data.userId,
      role: data.role ?? "member",
    })
    .returning();
  return rows[0]!;
}

export async function removeMember(db: Database, memberId: string) {
  const rows = await db
    .delete(communityServerMember)
    .where(eq(communityServerMember.id, memberId))
    .returning();
  return rows[0] ?? null;
}

export async function updateRole(db: Database, memberId: string, role: string) {
  const rows = await db
    .update(communityServerMember)
    .set({ role })
    .where(eq(communityServerMember.id, memberId))
    .returning();
  return rows[0] ?? null;
}

export async function listMembers(db: Database, serverId: string) {
  return db
    .select({
      id: communityServerMember.id,
      serverId: communityServerMember.serverId,
      userId: communityServerMember.userId,
      role: communityServerMember.role,
      nickname: communityServerMember.nickname,
      joinedAt: communityServerMember.joinedAt,
      userName: user.name,
      userEmail: user.email,
      userImage: user.image,
    })
    .from(communityServerMember)
    .innerJoin(user, eq(communityServerMember.userId, user.id))
    .where(eq(communityServerMember.serverId, serverId));
}

export async function updateRailOrder(
  db: Database,
  serverId: string,
  userId: string,
  railOrder: number
) {
  await db
    .update(communityServerMember)
    .set({ railOrder })
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        eq(communityServerMember.userId, userId)
      )
    );
}

export async function listMemberServerIds(db: Database, userId: string) {
  const rows = await db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .where(eq(communityServerMember.userId, userId));
  return rows.map((r) => r.serverId);
}

export async function getMember(db: Database, serverId: string, userId: string) {
  const rows = await db
    .select()
    .from(communityServerMember)
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        eq(communityServerMember.userId, userId)
      )
    );
  return rows[0] ?? null;
}

export async function getCoMemberUserIds(db: Database, userId: string): Promise<string[]> {
  const userServerIds = db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .where(eq(communityServerMember.userId, userId));

  const rows = await db
    .selectDistinct({ userId: communityServerMember.userId })
    .from(communityServerMember)
    .where(
      and(
        inArray(communityServerMember.serverId, userServerIds),
        ne(communityServerMember.userId, userId)
      )
    );
  return rows.map((r) => r.userId);
}
