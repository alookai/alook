import { and, eq, exists, gt, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
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
    maxActive?: number;
  }
) {
  if (data.maxActive !== undefined) {
    const id = nanoid();
    const token = nanoid(10);
    const createdAt = new Date().toISOString();
    const rows = await db
      .insert(communityServerInvite)
      .select(
        db
          .select({
            id: sql<string>`${id}`.as("id"),
            serverId: sql<string>`${data.serverId}`.as("server_id"),
            createdBy: sql<string>`${data.createdBy}`.as("created_by"),
            token: sql<string>`${token}`.as("token"),
            maxUses: sql<number | null>`${data.maxUses ?? null}`.as("max_uses"),
            uses: sql<number>`0`.as("uses"),
            expiresAt: sql<string | null>`${data.expiresAt ?? null}`.as("expires_at"),
            createdAt: sql<string>`${createdAt}`.as("created_at"),
          })
          .from(sql`(select 1)`)
          .where(
            lt(
              sql<number>`(
                select count(*)
                from ${communityServerInvite}
                where ${communityServerInvite.serverId} = ${data.serverId}
              )`,
              data.maxActive,
            ),
          ),
      )
      .returning();
    return rows[0] ?? null;
  }

  const rows = await db
    .insert(communityServerInvite)
    .values({
      serverId: data.serverId,
      createdBy: data.createdBy,
      maxUses: data.maxUses ?? null,
      expiresAt: data.expiresAt ?? null,
    })
    .returning();
  return rows[0] ?? null;
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

  // Consume capacity and create membership in one D1 batch. The INSERT itself
  // re-checks expiry/quota inside the write transaction, so two users racing
  // for the last use cannot both join. The UPDATE is gated on this request's
  // freshly-minted member id; a zero-row INSERT therefore cannot burn a use.
  // Conversely, a UNIQUE membership failure aborts the batch and rolls the
  // counter back, preserving the route's "Already a member" branch.
  const memberId = nanoid();
  const joinedAt = now;
  const insertMember = db
    .insert(communityServerMember)
    .select(
      db
        .select({
          id: sql<string>`${memberId}`.as("id"),
          serverId: communityServerInvite.serverId,
          userId: sql<string>`${userId}`.as("user_id"),
          role: sql<string>`${"member"}`.as("role"),
          railOrder: sql<number>`0`.as("rail_order"),
          joinedAt: sql<string>`${joinedAt}`.as("joined_at"),
        })
        .from(communityServerInvite)
        .where(
          and(
            eq(communityServerInvite.id, invite.id),
            or(
              isNull(communityServerInvite.expiresAt),
              gt(communityServerInvite.expiresAt, now),
            ),
            or(
              isNull(communityServerInvite.maxUses),
              lt(
                sql<number>`coalesce(${communityServerInvite.uses}, 0)`,
                communityServerInvite.maxUses,
              ),
            ),
          ),
        ),
    )
    .returning();
  const incrementUse = db
    .update(communityServerInvite)
    .set({ uses: sql`coalesce(${communityServerInvite.uses}, 0) + 1` })
    .where(
      and(
        eq(communityServerInvite.id, invite.id),
        exists(
          db
            .select({ id: communityServerMember.id })
            .from(communityServerMember)
            .where(eq(communityServerMember.id, memberId)),
        ),
      ),
    );
  const batchResults = (await db.batch([insertMember, incrementUse] as any)) as any[];
  const insertedMember = (batchResults[0] as Array<typeof communityServerMember.$inferSelect>)[0];
  if (!insertedMember) return null;

  // Join the joined-user row so WS listeners can render name/avatar without
  // waiting for the next /members refetch.
  const userRows = await db
    .select({
      name: user.name,
      image: user.image,
      avatarVersion: user.avatarVersion,
      discriminator: user.discriminator,
    })
    .from(user)
    .where(eq(user.id, userId));
  const userRow = userRows[0];

  return {
    invite,
    member: {
      ...insertedMember,
      userName: userRow?.name ?? "",
      userImage: userRow?.image ?? null,
      userAvatarVersion: userRow?.avatarVersion ?? 0,
      discriminator: userRow?.discriminator ?? null,
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
      creatorAvatarVersion: user.avatarVersion,
    })
    .from(communityServerInvite)
    .leftJoin(user, eq(user.id, communityServerInvite.createdBy))
    .where(eq(communityServerInvite.serverId, serverId));
}
