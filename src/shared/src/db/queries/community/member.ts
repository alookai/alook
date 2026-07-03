import { eq, and, ne, inArray, count, asc, or, gt, like } from "drizzle-orm";
import { communityServerMember } from "../../community-schema";
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
