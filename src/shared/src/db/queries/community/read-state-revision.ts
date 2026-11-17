import { and, eq, exists, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { communityReadStateRevision } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export function humanUserExistsCondition(db: Database, userId: SQLWrapper) {
  return exists(db.select({ id: user.id }).from(user).where(and(
    eq(user.id, userId), eq(user.isBot, false),
  )));
}

/**
 * Bulk sibling used by destructive mutations that may replace/remove rows for
 * several human accounts at once. `condition` is evaluated inside the same D1
 * batch immediately before the destructive statement, so a raced loser does
 * not mint revisions for a mutation it did not commit.
 */
export function advanceReadStateRevisionsForUsersBuilder(
  db: Database,
  userIds: string[],
  condition: SQL<unknown>,
) {
  const ids = JSON.stringify([...new Set(userIds)]);
  const selected = db
    .select({
      userId: sql<string>`CAST(value AS TEXT)`.as("user_id"),
      revision: sql<number>`1`.as("revision"),
    })
    .from(sql`json_each(${ids})`)
    .where(condition);
  return db
    .insert(communityReadStateRevision)
    .select(selected)
    .onConflictDoUpdate({
      target: communityReadStateRevision.userId,
      set: { revision: sql`${communityReadStateRevision.revision} + 1` },
    })
    .returning({
      userId: communityReadStateRevision.userId,
      revision: communityReadStateRevision.revision,
    });
}

