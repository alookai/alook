import { eq, and, or, gt, isNull, sql } from "drizzle-orm";
import {
  communityServerInvite,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function createInvite(
  db: Database,
  data: {
    serverId: string;
    createdBy: string;
    maxUses?: number;
    expiresAt?: string;
  }
) {
  const rows = await db
    .insert(communityServerInvite)
    .values({
      serverId: data.serverId,
      createdBy: data.createdBy,
      maxUses: data.maxUses ?? null,
      expiresAt: data.expiresAt ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function getInvite(db: Database, inviteId: string) {
  const rows = await db
    .select()
    .from(communityServerInvite)
    .where(eq(communityServerInvite.id, inviteId));
  return rows[0] ?? null;
}

export async function getInviteByToken(db: Database, token: string) {
  const rows = await db
    .select()
    .from(communityServerInvite)
    .where(eq(communityServerInvite.token, token));
  return rows[0] ?? null;
}

export async function revokeInvite(db: Database, inviteId: string) {
  const rows = await db
    .delete(communityServerInvite)
    .where(eq(communityServerInvite.id, inviteId))
    .returning();
  return rows[0]!;
}

export async function useInvite(
  db: Database,
  token: string,
  userId: string
) {
  // Find invite by token
  const invites = await db
    .select()
    .from(communityServerInvite)
    .where(eq(communityServerInvite.token, token));

  const invite = invites[0];
  if (!invite) return null;

  // Validate: not expired
  const now = new Date().toISOString();
  if (invite.expiresAt && invite.expiresAt <= now) {
    return null;
  }

  // Validate: uses < maxUses (or maxUses is null = unlimited)
  if (invite.maxUses !== null && (invite.uses ?? 0) >= invite.maxUses) {
    return null;
  }

  // Atomic increment uses
  await db
    .update(communityServerInvite)
    .set({ uses: sql`${communityServerInvite.uses} + 1` })
    .where(eq(communityServerInvite.id, invite.id));

  // Insert new server member
  const memberRows = await db
    .insert(communityServerMember)
    .values({
      serverId: invite.serverId,
      userId,
      role: "member",
    })
    .returning();
  const insertedMember = memberRows[0]!;

  // Join the joined-user row so WS listeners can render name/avatar without
  // waiting for the next /members refetch.
  const userRows = await db
    .select({ name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, userId));
  const userRow = userRows[0];

  return {
    invite,
    member: {
      ...insertedMember,
      userName: userRow?.name ?? "",
      userImage: userRow?.image ?? null,
    },
  };
}

export async function listServerInvites(db: Database, serverId: string) {
  return db
    .select({
      id: communityServerInvite.id,
      serverId: communityServerInvite.serverId,
      token: communityServerInvite.token,
      maxUses: communityServerInvite.maxUses,
      uses: communityServerInvite.uses,
      expiresAt: communityServerInvite.expiresAt,
      createdAt: communityServerInvite.createdAt,
      creatorId: user.id,
      creatorName: user.name,
      creatorEmail: user.email,
      creatorImage: user.image,
    })
    .from(communityServerInvite)
    .leftJoin(user, eq(user.id, communityServerInvite.createdBy))
    .where(eq(communityServerInvite.serverId, serverId));
}
