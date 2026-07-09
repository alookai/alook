import { eq, and, ne, inArray, count, asc, or, gt, like, isNull, sql } from "drizzle-orm";
import { communityServerMember, communityChannel, communityDmConversation } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import {
  DEFAULT_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "../../../constants/community";
import { escapeLikePattern } from "../../../utils/sql-like";

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
  // deletedAt filter — a bot (or a soft-deleted human) is hidden from every
  // member list. History surfaces still hydrate cached name/avatar via
  // `getUsersByIds` (which never filters `deletedAt`), so tombstone rendering
  // still works.
  // Return type MUST NOT include isBot/ownerUserId — the route response
  // projection is responsible for owner-scoped `isBot` gating.
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
      userIsBot: user.isBot,
      userOwnerUserId: user.ownerUserId,
      discriminator: user.discriminator,
    })
    .from(communityServerMember)
    .innerJoin(user, eq(communityServerMember.userId, user.id))
    .where(and(eq(communityServerMember.serverId, serverId), isNull(user.deletedAt)));
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

export async function bulkUpdateRailOrder(
  db: Database,
  userId: string,
  orderedServerIds: string[]
) {
  if (orderedServerIds.length === 0) return;
  const statements = orderedServerIds.map((serverId, railOrder) =>
    db
      .update(communityServerMember)
      .set({ railOrder })
      .where(
        and(
          eq(communityServerMember.userId, userId),
          eq(communityServerMember.serverId, serverId)
        )
      )
  );
  await db.batch(statements as [typeof statements[0], ...typeof statements]);
}

export async function listMemberServerIds(db: Database, userId: string) {
  const rows = await db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .where(eq(communityServerMember.userId, userId));
  return rows.map((r) => r.serverId);
}

// Schema has no soft-delete flag on communityServerMember (only cascade FK) —
// no `deletedAt IS NULL` filter needed. If soft-delete is ever added, add
// the guard here and in `countMembers` / `listMembersPaginated`.
export async function listMemberUserIds(db: Database, serverId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: communityServerMember.userId })
    .from(communityServerMember)
    .where(eq(communityServerMember.serverId, serverId));
  return rows.map((r) => r.userId);
}

export async function countMembers(db: Database, serverId: string): Promise<number> {
  const rows = await db
    .select({ cnt: count() })
    .from(communityServerMember)
    .where(eq(communityServerMember.serverId, serverId));
  return rows[0]?.cnt ?? 0;
}

export async function listMembersPaginated(
  db: Database,
  serverId: string,
  opts: { cursor?: { joinedAt: string; id: string }; limit?: number }
): Promise<{
  members: Array<{
    id: string;
    serverId: string;
    userId: string;
    role: string | null;
    nickname: string | null;
    joinedAt: string;
    userName: string | null;
    userEmail: string;
    userImage: string | null;
    userIsBot: boolean;
    userOwnerUserId: string | null;
    discriminator: string | null;
  }>;
  hasMore: boolean;
  cursor: { joinedAt: string; id: string } | undefined;
}> {
  const rawLimit = opts.limit ?? DEFAULT_MEMBERS_PAGE_SIZE;
  const limit = Math.max(1, Math.min(rawLimit, MAX_MEMBERS_PAGE_SIZE));

  const conditions: ReturnType<typeof eq>[] = [
    eq(communityServerMember.serverId, serverId),
  ];

  if (opts.cursor) {
    conditions.push(
      or(
        gt(communityServerMember.joinedAt, opts.cursor.joinedAt),
        and(
          eq(communityServerMember.joinedAt, opts.cursor.joinedAt),
          gt(communityServerMember.id, opts.cursor.id)
        )
      )! as ReturnType<typeof eq>
    );
  }

  // Filter soft-deleted user rows from paginated listings.
  conditions.push(isNull(user.deletedAt) as any);
  const rows = await db
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
      userIsBot: user.isBot,
      userOwnerUserId: user.ownerUserId,
      discriminator: user.discriminator,
    })
    .from(communityServerMember)
    .innerJoin(user, eq(communityServerMember.userId, user.id))
    .where(and(...conditions))
    .orderBy(asc(communityServerMember.joinedAt), asc(communityServerMember.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const members = hasMore ? rows.slice(0, limit) : rows;
  const last = members[members.length - 1];
  const cursor =
    hasMore && last ? { joinedAt: last.joinedAt, id: last.id } : undefined;

  return { members, hasMore, cursor };
}

// Prefix search across name / email / nickname for a single server. Ordered
// by user.name ASC, id ASC. Capped at MAX_MEMBERS_PAGE_SIZE.
//
// Blocked users are intentionally NOT filtered here: `listMembers` and
// `listMembersPaginated` don't filter blocked users either, and mixing the
// two semantics would give scroll and search different visible-member sets.
// Block controls DM/mention/reply reach — server membership visibility is a
// separate concern.
export async function searchMembers(
  db: Database,
  serverId: string,
  q: string,
  opts?: { limit?: number }
) {
  const rawLimit = opts?.limit ?? MAX_MEMBERS_PAGE_SIZE;
  const limit = Math.max(1, Math.min(rawLimit, MAX_MEMBERS_PAGE_SIZE));
  // LIKE escape user input BEFORE appending the prefix wildcard — otherwise a
  // single "%" in the query matches every row.
  const pattern = `${escapeLikePattern(q)}%`;

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
      discriminator: user.discriminator,
    })
    .from(communityServerMember)
    .innerJoin(user, eq(communityServerMember.userId, user.id))
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        or(
          like(user.name, pattern),
          like(user.email, pattern),
          like(communityServerMember.nickname, pattern)
        )
      )
    )
    .orderBy(asc(user.name), asc(communityServerMember.id))
    .limit(limit);
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

// Scope-first single-member lookup. `WHERE id = ? AND server_id = ?` — cross
// server memberIds never resolve, so callers don't need to post-check
// ownership. Return shape mirrors `listMembers` (joined against `user` so
// downstream broadcasts/audit calls have `userName` etc without a second
// round-trip).
export async function getMemberById(
  db: Database,
  memberId: string,
  opts: { serverId: string }
) {
  const rows = await db
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
    .where(
      and(
        eq(communityServerMember.id, memberId),
        eq(communityServerMember.serverId, opts.serverId)
      )
    );
  return rows[0] ?? null;
}

export async function getMemberships(db: Database, userId: string, serverIds: string[]) {
  if (serverIds.length === 0) return [];
  return db
    .select()
    .from(communityServerMember)
    .where(
      and(
        eq(communityServerMember.userId, userId),
        inArray(communityServerMember.serverId, serverIds)
      )
    );
}

/**
 * Owner-leaves-server cascade — SELECT the bot userIds that will be removed
 * from `serverId` because their owner is leaving. Called as step 1 of the
 * three-step leave/kick sequence (see §Owner-leaves-server in plan).
 */
export async function listOwnerBotsInServer(
  db: Database,
  serverId: string,
  ownerUserId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(communityServerMember, eq(communityServerMember.userId, user.id))
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        eq(user.ownerUserId, ownerUserId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
  return rows.map((r) => r.id);
}

/**
 * Statement-returning DELETE for the owner-leaves cascade. Takes an already-
 * resolved bot user id list so the batch is atomic AND auditable (no hidden
 * subquery). Empty list → no-op (returned as a DELETE with an unsatisfiable
 * predicate, since Drizzle rejects `inArray([])`).
 */
export function removeOwnerBotsFromServerStatement(
  db: Database,
  serverId: string,
  botUserIds: string[]
) {
  if (botUserIds.length === 0) {
    // No-op statement — DELETE with an unsatisfiable predicate. D1's batch
    // shape still needs a statement even for empty lists. Drizzle rejects
    // `inArray([])`, so this is the AGENTS.md-carved-out case where a raw
    // `sql\`1 = 0\`` is the only option.
    return db
      .delete(communityServerMember)
      .where(sql`1 = 0`);
  }
  return db
    .delete(communityServerMember)
    .where(
      and(
        eq(communityServerMember.serverId, serverId),
        inArray(communityServerMember.userId, botUserIds)
      )
    );
}

/** Executes `removeOwnerBotsFromServerStatement` — one DELETE for all bots. */
export async function removeOwnerBotsFromServer(
  db: Database,
  serverId: string,
  botUserIds: string[],
) {
  await removeOwnerBotsFromServerStatement(db, serverId, botUserIds);
}

/**
 * Wake-dispatch access re-check (unread-wake rebuild path,
 * `buildUnreadWakeCommand`) — scoped in SQL before returning, per
 * AGENTS.md's "scope the queries before, not check ownership after". A
 * queued wake item can be stale by the time it's consumed (membership
 * revoked, DM peer changed); this must return false rather than let the
 * caller wake a bot that lost access to the scope.
 *
 * Thread scopes are ordinary `communityChannel` rows (own id, own
 * `serverId`) — the same server-membership check as a top-level channel
 * covers them, no separate thread-membership concept exists.
 */
export async function canBotReadWakeScope(
  db: Database,
  botUserId: string,
  scope: { channelId?: string; dmConversationId?: string }
): Promise<boolean> {
  if (scope.channelId) {
    const rows = await db
      .select({ serverId: communityChannel.serverId })
      .from(communityChannel)
      .innerJoin(
        communityServerMember,
        and(
          eq(communityServerMember.serverId, communityChannel.serverId),
          eq(communityServerMember.userId, botUserId)
        )
      )
      .where(eq(communityChannel.id, scope.channelId))
      .limit(1);
    return rows.length > 0;
  }
  if (scope.dmConversationId) {
    const rows = await db
      .select({ id: communityDmConversation.id })
      .from(communityDmConversation)
      .where(
        and(
          eq(communityDmConversation.id, scope.dmConversationId),
          or(
            eq(communityDmConversation.user1Id, botUserId),
            eq(communityDmConversation.user2Id, botUserId)
          )
        )
      )
      .limit(1);
    return rows.length > 0;
  }
  return false;
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
