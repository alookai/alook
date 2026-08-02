import { eq, and, or, gt, isNull, sql } from "drizzle-orm";
import {
  communityServerInvite,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { withD1Retry } from "../../resilience";

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

  // Insert the member row AND increment `uses` as ONE atomic `db.batch` unit,
  // wrapped in `withD1Retry` (D1-armor state 3). Rationale (Blondie #244):
  //   - The `(serverId, userId)` UNIQUE guards against a double-join; a real
  //     duplicate rethrows the (non-retryable) constraint, which the route maps
  //     to "Already a member". So a blind retry can never OVER-count `uses`.
  //   - But these two writes MUST be atomic. If they ran as separate statements
  //     under one retry, a transient on the `uses` bump AFTER the member insert
  //     committed would, on retry, hit the UNIQUE on the re-inserted member and
  //     rethrow — leaving the member joined but `uses` never incremented
  //     (UNDER-count: a silently un-consumed invite slot). The batch makes ①②
  //     all-or-nothing, so the member row and the `uses` bump commit together or
  //     not at all; retrying the whole batch is safe (D1 batches are atomic).
  //   - Member INSERT is ①; incrementing `uses` before it would burn a slot on
  //     every rejected attempt, so the insert stays first WITHIN the batch.
  // The WS-hydration user read (③) stays OUTSIDE — it's a read, benign on
  // failure, and must not be inside the atomic write unit.
  const batchResults = (await withD1Retry(
    () =>
      db.batch([
        db
          .insert(communityServerMember)
          .values({
            serverId: invite.serverId,
            userId,
            role: "member",
          })
          .returning(),
        db
          .update(communityServerInvite)
          .set({ uses: sql`${communityServerInvite.uses} + 1` })
          .where(eq(communityServerInvite.id, invite.id)),
      ] as const),
    { route: "invite/use" },
  )) as unknown as [Array<typeof communityServerMember.$inferSelect>, unknown];
  const insertedMember = batchResults[0][0]!;

  // Join the joined-user row so WS listeners can render name/avatar without
  // waiting for the next /members refetch.
  const userRows = await db
    .select({ name: user.name, image: user.image, discriminator: user.discriminator })
    .from(user)
    .where(eq(user.id, userId));
  const userRow = userRows[0];

  return {
    invite,
    member: {
      ...insertedMember,
      userName: userRow?.name ?? "",
      userImage: userRow?.image ?? null,
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
    })
    .from(communityServerInvite)
    .leftJoin(user, eq(user.id, communityServerInvite.createdBy))
    .where(eq(communityServerInvite.serverId, serverId));
}
