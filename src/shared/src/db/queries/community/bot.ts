/**
 * Community bots — first-class community identities owned by users, bound to
 * a paired machine + runtime.
 *
 * ── Ownership scoping invariant ─────────────────────────────────────────────
 *
 * Every read/write on bot state MUST scope by `ownerUserId` in its WHERE
 * clause. No post-hoc ownership checks anywhere.
 *
 * D1 batches do NOT roll back on zero-row matches — only on statement error.
 * A multi-statement batch where statement 1 no-ops on
 * `WHERE id = :botId AND ownerUserId = :ctx.userId` while statements 2/3 use
 * plain `WHERE userId = :botId` would let a cross-owner call vandalize the
 * victim's state. Every batch statement carries the `ownerUserId` predicate
 * independently, via subquery.
 *
 * After each batch, inspect the primary statement's `changes`. Zero rows →
 * return null / 404 at the route. The victim's state must be untouched.
 */

import { aliasedTable, and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { user } from "../../schema";
import {
  communityBotBinding,
  communityAgentRunnerKey,
} from "../../community-machine-schema";
import {
  communityBotApprovalRequest,
  communityServerMember,
  communityMessage,
  communityFriendship,
  communityUserProfile,
} from "../../community-schema";
import { communityMachine } from "../../community-machine-schema";
import type { Database } from "../../index";
import { communityBotSyntheticEmail } from "../../../constants";
import { computeDiscriminator } from "../../../lib/discriminator";
import { nanoid } from "nanoid";

// ─── Types ──────────────────────────────────────────────────────────────────

export type BotRow = {
  id: string;
  name: string;
  image: string | null;
  ownerUserId: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type BotBinding = {
  userId: string;
  machineId: string;
  runtime: string;
  createdAt: string;
};

export class OwnerHasBotsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerHasBotsError";
  }
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * List live bots owned by `ownerId`. Filters `isBot=true AND deletedAt IS NULL`.
 * Joined against `communityBotBinding` for machine/runtime overlay.
 */
export async function listBotsForOwner(
  db: Database,
  ownerId: string
): Promise<Array<BotRow & { machineId: string; runtime: string }>> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      ownerUserId: user.ownerUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      description: communityUserProfile.aboutMe,
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
    })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .leftJoin(
      communityUserProfile,
      eq(communityUserProfile.userId, user.id)
    )
    .where(
      and(
        eq(user.isBot, true),
        eq(user.ownerUserId, ownerId),
        isNull(user.deletedAt)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    image: r.image,
    ownerUserId: r.ownerUserId!,
    description: r.description ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    machineId: r.machineId,
    runtime: r.runtime,
  }));
}

/**
 * Get a bot iff it's owned by `ownerId`. Returns null on any mismatch — this
 * is the ownership-scoping gate for every bot-mutating route.
 */
export async function getBotOwnedBy(
  db: Database,
  botId: string,
  ownerId: string
): Promise<(BotRow & { machineId: string | null; runtime: string | null }) | null> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      ownerUserId: user.ownerUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      description: communityUserProfile.aboutMe,
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
    })
    .from(user)
    .leftJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .leftJoin(
      communityUserProfile,
      eq(communityUserProfile.userId, user.id)
    )
    .where(
      and(
        eq(user.id, botId),
        eq(user.isBot, true),
        eq(user.ownerUserId, ownerId),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    image: r.image,
    ownerUserId: r.ownerUserId!,
    description: r.description ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    machineId: r.machineId ?? null,
    runtime: r.runtime ?? null,
  };
}

/** Cheap ownership probe used by ack/error paths. */
export async function countLiveBotsForOwner(
  db: Database,
  ownerId: string
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(user)
    .where(
      and(
        eq(user.isBot, true),
        eq(user.ownerUserId, ownerId),
        isNull(user.deletedAt)
      )
    );
  return rows[0]?.n ?? 0;
}

/** Get bot binding by userId. Returns null if none. */
export async function getBotBinding(
  db: Database,
  botId: string
): Promise<{ machineId: string; runtime: string } | null> {
  const rows = await db
    .select({
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
    })
    .from(communityBotBinding)
    .where(eq(communityBotBinding.userId, botId))
    .limit(1);
  return rows[0] ?? null;
}

/** Bots bound to this machine — daemon cold-start warmup uses this. */
export async function listBotsForMachine(
  db: Database,
  machineId: string
): Promise<Array<{ id: string; name: string; description: string }>> {
  // Guard against orphaned bots: if a future flow soft-deletes an owner user
  // without cascading their bots, don't hand them to the daemon for warmup.
  const owner = aliasedTable(user, "owner");
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      description: communityUserProfile.aboutMe,
    })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .innerJoin(owner, eq(owner.id, user.ownerUserId))
    .leftJoin(
      communityUserProfile,
      eq(communityUserProfile.userId, user.id)
    )
    .where(
      and(
        eq(communityBotBinding.machineId, machineId),
        eq(user.isBot, true),
        isNull(user.deletedAt),
        isNull(owner.deletedAt)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
  }));
}

/**
 * List server ids the bot is currently a member of. Used before soft-delete
 * so the caller can fan out MEMBER_LEAVE for each server.
 */
export async function listBotServerMemberships(
  db: Database,
  botId: string,
  ownerId: string
): Promise<string[]> {
  const rows = await db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .innerJoin(user, eq(user.id, communityServerMember.userId))
    .where(
      and(
        eq(communityServerMember.userId, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true)
      )
    );
  return rows.map((r) => r.serverId);
}

/** Machine-delete UX preflight: which bots would cascade? */
export async function listBotsBoundToMachine(
  db: Database,
  machineId: string,
  ownerId: string
): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: user.id, name: user.name })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .where(
      and(
        eq(communityBotBinding.machineId, machineId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
}

// ─── Writes ────────────────────────────────────────────────────────────────

export type CreateBotInput = {
  ownerId: string;
  name: string;
  description?: string;
  machineId: string;
  runtime: string;
  image?: string | null;
};

/**
 * Atomic bot creation. Three statements:
 *   1. INSERT `user` (isBot=true, ownerUserId, synthetic email, image).
 *   2. INSERT `community_bot_binding` (machineId + runtime).
 *   3. INSERT `community_user_profile` (aboutMe = description).
 *
 * Batched so all commit or none. Returns the bot row.
 */
export async function createBot(
  db: Database,
  data: CreateBotInput
): Promise<{ botId: string; name: string; description: string; image: string | null }> {
  const botId = nanoid();
  const email = communityBotSyntheticEmail(botId);
  const nowIso = new Date().toISOString();
  const description = data.description ?? "";

  // Three-statement batch. D1 rolls back all on any error.
  const stmt1 = db.insert(user).values({
    id: botId,
    name: data.name,
    email,
    emailVerified: true,
    image: data.image ?? null,
    isBot: true,
    ownerUserId: data.ownerId,
    discriminator: computeDiscriminator(botId),
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const stmt2 = db.insert(communityBotBinding).values({
    userId: botId,
    machineId: data.machineId,
    runtime: data.runtime,
    createdAt: nowIso,
  });
  // Match updateBot's upsert semantics — reincarnation paths (nanoid collision
  // aside, future flows that recycle a botId) shouldn't roll the batch back on
  // a profile PK conflict.
  const stmt3 = db
    .insert(communityUserProfile)
    .values({ userId: botId, aboutMe: description })
    .onConflictDoUpdate({
      target: communityUserProfile.userId,
      set: { aboutMe: description },
    });
  await db.batch([stmt1, stmt2, stmt3] as any);

  return {
    botId,
    name: data.name,
    description,
    image: data.image ?? null,
  };
}

/**
 * Update bot fields. UPDATE predicate carries `ownerUserId + isBot + deletedAt IS NULL`
 * so a cross-owner call is a no-op with zero rows changed.
 * Returns the updated row, or null if the predicate matched zero rows.
 */
export async function updateBot(
  db: Database,
  botId: string,
  ownerId: string,
  data: { name?: string; description?: string; image?: string | null }
): Promise<{ botId: string; name: string; description: string; image: string | null } | null> {
  const set: { name?: string; image?: string | null; updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (data.name !== undefined) set.name = data.name;
  if (data.image !== undefined) set.image = data.image;

  // When description is changing, batch the user UPDATE + profile upsert so a
  // concurrent softDeleteBot can't slip in between and leave a fresh description
  // on a tombstoned bot. The upsert INSERT branch is safe (createBot writes the
  // profile row); it only fires for legacy rows that pre-date the profile write.
  let rows: Array<{ id: string; name: string; image: string | null }>;
  if (data.description !== undefined) {
    const s1 = db
      .update(user)
      .set(set)
      .where(
        and(
          eq(user.id, botId),
          eq(user.ownerUserId, ownerId),
          eq(user.isBot, true),
          isNull(user.deletedAt)
        )
      )
      .returning({ id: user.id, name: user.name, image: user.image });
    const s2 = db
      .insert(communityUserProfile)
      .values({ userId: botId, aboutMe: data.description })
      .onConflictDoUpdate({
        target: communityUserProfile.userId,
        set: { aboutMe: data.description },
      });
    const results = (await db.batch([s1, s2] as any)) as any[];
    rows = Array.isArray(results?.[0]) ? results[0] : [];
  } else {
    rows = await db
      .update(user)
      .set(set)
      .where(
        and(
          eq(user.id, botId),
          eq(user.ownerUserId, ownerId),
          eq(user.isBot, true),
          isNull(user.deletedAt)
        )
      )
      .returning({ id: user.id, name: user.name, image: user.image });
  }

  if (rows.length === 0) return null;

  let description = data.description ?? "";
  if (data.description === undefined) {
    const profileRows = await db
      .select({ aboutMe: communityUserProfile.aboutMe })
      .from(communityUserProfile)
      .where(eq(communityUserProfile.userId, botId))
      .limit(1);
    description = profileRows[0]?.aboutMe ?? "";
  }

  return {
    botId: rows[0]!.id,
    name: rows[0]!.name,
    description,
    image: rows[0]!.image,
  };
}

/**
 * Soft-delete a bot atomically:
 *   1. UPDATE `user` set deletedAt (scoped by ownerUserId + isBot).
 *   2. DELETE `community_server_member` rows (scoped by ownerUserId subquery).
 *   3. UPDATE `community_agent_runner_key` set revokedAt (scoped by ownerUserId subquery).
 *   4. DELETE `community_bot_binding` (scoped by ownerUserId subquery).
 *
 * Every statement carries the `ownerUserId` predicate via subquery — see
 * §Ownership scoping invariant. Returns true iff step 1 changed a row.
 */
export async function softDeleteBot(
  db: Database,
  botId: string,
  ownerId: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // Ownership-scoping subquery — used by every statement so a cross-owner
  // botId is a no-op across the whole batch.
  const ownerScopedIds = db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.id, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true)
      )
    );

  // Use RETURNING on the primary UPDATE so we can portably detect whether the
  // soft-delete landed — driver-specific `meta.changes` shapes differ between
  // D1 (`.meta.changes`), the libsql/sqlite test driver (rows[]), and future
  // shims, and mis-reads can flip a real success into a 404.
  const s1 = db
    .update(user)
    .set({ deletedAt: nowIso, updatedAt: nowIso })
    .where(
      and(
        eq(user.id, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    )
    .returning({ id: user.id });
  const s2 = db
    .delete(communityServerMember)
    .where(inArray(communityServerMember.userId, ownerScopedIds));
  const s3 = db
    .update(communityAgentRunnerKey)
    .set({ revokedAt: nowIso })
    .where(
      and(
        eq(communityAgentRunnerKey.agentId, botId),
        isNull(communityAgentRunnerKey.revokedAt),
        inArray(communityAgentRunnerKey.userId, ownerScopedIds)
      )
    );
  const s4 = db
    .delete(communityBotBinding)
    .where(inArray(communityBotBinding.userId, ownerScopedIds));

  const results = (await db.batch([s1, s2, s3, s4] as any)) as any[];
  // With RETURNING, statement 1 returns an array of matched rows. Zero rows
  // means the predicate didn't match (cross-owner or already-tombstoned).
  const firstRows = Array.isArray(results?.[0]) ? results[0] : [];
  return firstRows.length > 0;
}

/**
 * Ship a real guard so future user-delete plumbing has a clear failure mode.
 * Throws `OwnerHasBotsError` when a user still has live bots. No callers
 * today; called by any future delete-endpoint before it fires.
 */
export async function assertNoLiveBots(
  db: Database,
  userId: string
): Promise<void> {
  const n = await countLiveBotsForOwner(db, userId);
  if (n > 0) {
    throw new OwnerHasBotsError(
      `user ${userId} has ${n} live bots; delete them first`
    );
  }
}

// ─── Approval requests ──────────────────────────────────────────────────────

export type ApprovalKind = "join_server" | "friend";
export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRequestRow = {
  id: string;
  botId: string;
  kind: ApprovalKind;
  serverId: string | null;
  requestedByUserId: string;
  dmMessageId: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
};

export async function getApprovalRequest(
  db: Database,
  id: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(eq(communityBotApprovalRequest.id, id))
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

export async function listPendingApprovalsForBot(
  db: Database,
  botId: string
): Promise<ApprovalRequestRow[]> {
  return (await db
    .select()
    .from(communityBotApprovalRequest)
    .where(
      and(
        eq(communityBotApprovalRequest.botId, botId),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )) as ApprovalRequestRow[];
}

/**
 * Look up pending join_server approval for a given (botId, serverId). Used
 * as an idempotency guard before we write a duplicate DM card.
 */
export async function findPendingJoinRequest(
  db: Database,
  botId: string,
  serverId: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(
      and(
        eq(communityBotApprovalRequest.botId, botId),
        eq(communityBotApprovalRequest.serverId, serverId),
        eq(communityBotApprovalRequest.kind, "join_server"),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

export async function findPendingFriendRequest(
  db: Database,
  botId: string,
  requestedByUserId: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(
      and(
        eq(communityBotApprovalRequest.botId, botId),
        eq(communityBotApprovalRequest.requestedByUserId, requestedByUserId),
        eq(communityBotApprovalRequest.kind, "friend"),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

/**
 * Statement-returning insert. Application layer enforces the
 * `kind = "join_server" ⇔ serverId != null` invariant (SQLite CHECK can't
 * cross-reference other tables cleanly).
 */
export function createApprovalRequestStatement(
  db: Database,
  data: {
    botId: string;
    kind: ApprovalKind;
    serverId: string | null;
    requestedByUserId: string;
    dmMessageId: string;
  }
) {
  if (data.kind === "join_server" && !data.serverId) {
    throw new Error("createApprovalRequest: join_server requires serverId");
  }
  if (data.kind === "friend" && data.serverId !== null) {
    throw new Error("createApprovalRequest: friend request must have serverId=null");
  }
  return db.insert(communityBotApprovalRequest).values({
    botId: data.botId,
    kind: data.kind,
    serverId: data.serverId,
    requestedByUserId: data.requestedByUserId,
    dmMessageId: data.dmMessageId,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
}

export async function resolveApprovalRequest(
  db: Database,
  id: string,
  status: "approved" | "denied"
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .update(communityBotApprovalRequest)
    .set({ status, resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(communityBotApprovalRequest.id, id),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )
    .returning();
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

/**
 * Lookup an approval request row by its DM message id. Used by the DM card
 * hydrator to render approve/deny/approved/denied variants.
 */
export async function getApprovalRequestByDmMessageId(
  db: Database,
  dmMessageId: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(eq(communityBotApprovalRequest.dmMessageId, dmMessageId))
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

/** Batch-hydrate approval-request rows for a set of DM message ids. */
export async function listApprovalRequestsByDmMessageIds(
  db: Database,
  ids: string[]
): Promise<ApprovalRequestRow[]> {
  if (ids.length === 0) return [];
  return (await db
    .select()
    .from(communityBotApprovalRequest)
    .where(inArray(communityBotApprovalRequest.dmMessageId, ids))) as ApprovalRequestRow[];
}

// ─── Machine cascade helpers ─────────────────────────────────────────────

/**
 * Verify a machine belongs to `ownerId` — used by /api/community/bots create
 * to gate machine ownership + look up available runtimes.
 */
export async function getMachineForOwner(
  db: Database,
  machineId: string,
  ownerId: string
): Promise<{
  id: string;
  availableRuntimes: Array<{
    id: string;
    version?: string;
    status?: "healthy" | "unhealthy";
    lastError?: string;
    lastErrorAt?: string;
  }>;
} | null> {
  const rows = await db
    .select({
      id: communityMachine.id,
      availableRuntimes: communityMachine.availableRuntimes,
    })
    .from(communityMachine)
    .where(and(eq(communityMachine.id, machineId), eq(communityMachine.userId, ownerId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  // Normalize: legacy rows store `string[]`, current rows store
  // `{id, version?, status?, lastError?, lastErrorAt?}[]`. Drop empty ids so
  // the route's `.includes()` / `.find()` checks can't be fooled by `""`.
  const raw = (r.availableRuntimes ?? []) as Array<unknown>;
  const normalized: Array<{
    id: string;
    version?: string;
    status?: "healthy" | "unhealthy";
    lastError?: string;
    lastErrorAt?: string;
  }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.length > 0) normalized.push({ id: entry });
    } else if (entry && typeof entry === "object") {
      const obj = entry as {
        id?: unknown;
        version?: unknown;
        status?: unknown;
        lastError?: unknown;
        lastErrorAt?: unknown;
      };
      if (typeof obj.id === "string" && obj.id.length > 0) {
        const status =
          obj.status === "unhealthy" ? "unhealthy" : obj.status === "healthy" ? "healthy" : undefined;
        normalized.push({
          id: obj.id,
          ...(typeof obj.version === "string" ? { version: obj.version } : {}),
          ...(status ? { status } : {}),
          ...(typeof obj.lastError === "string" ? { lastError: obj.lastError } : {}),
          ...(typeof obj.lastErrorAt === "string" ? { lastErrorAt: obj.lastErrorAt } : {}),
        });
      }
    }
  }
  return { id: r.id, availableRuntimes: normalized };
}
