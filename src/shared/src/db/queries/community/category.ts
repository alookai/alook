import { and, asc, eq, inArray, count, sql } from "drizzle-orm";
import { communityCategory, communityChannel } from "../../community-schema";
import type { Database } from "../../index";
import { jsonTextSet } from "../_json-set";

export async function getCategoriesByIds(db: Database, categoryIds: string[]) {
  if (categoryIds.length === 0) return [];
  const ids = jsonTextSet(db, [...new Set(categoryIds)]);
  return db
    .select()
    .from(communityCategory)
    .where(inArray(communityCategory.id, ids));
}

/**
 * Category dictionary for a server, ordered by position asc then id asc for
 * stable deterministic ordering. Used by the agent `channel list` route to
 * bucket channels into groups without a per-row join.
 */
export async function listCategoriesByServer(db: Database, serverId: string) {
  return db
    .select({
      id: communityCategory.id,
      name: communityCategory.name,
      position: communityCategory.position,
      private: communityCategory.private,
    })
    .from(communityCategory)
    .where(eq(communityCategory.serverId, serverId))
    .orderBy(asc(communityCategory.position), asc(communityCategory.id));
}

export async function createCategory(
  db: Database,
  data: { serverId: string; name: string; private?: boolean; creatorId?: string }
) {
  const rows = await db
    .insert(communityCategory)
    .values({
      serverId: data.serverId,
      name: data.name,
      private: data.private ? 1 : 0,
      creatorId: data.creatorId ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function getCategory(db: Database, categoryId: string) {
  const rows = await db
    .select()
    .from(communityCategory)
    .where(eq(communityCategory.id, categoryId));
  return rows[0] ?? null;
}

export async function updateCategory(
  db: Database,
  categoryId: string,
  data: { name?: string; private?: boolean }
) {
  const setData: { name?: string; private?: number } = {};
  if (data.name !== undefined) setData.name = data.name;
  if (data.private !== undefined) setData.private = data.private ? 1 : 0;

  const rows = await db
    .update(communityCategory)
    .set(setData)
    .where(eq(communityCategory.id, categoryId))
    .returning();
  return rows[0] ?? null;
}

export async function deleteCategory(db: Database, categoryId: string) {
  const rows = await db
    .delete(communityCategory)
    .where(eq(communityCategory.id, categoryId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Whether a category still contains any channel. Gates the private/public
 * toggle and category delete (both blocked when non-empty to prevent a
 * privacy-class flip / `set null` widening). See
 * plans/channel-category-role-permissions.md.
 */
export async function hasChannels(db: Database, categoryId: string): Promise<boolean> {
  const rows = await db
    .select({ cnt: count() })
    .from(communityChannel)
    .where(eq(communityChannel.categoryId, categoryId));
  return (rows[0]?.cnt ?? 0) > 0;
}

export async function reorderCategories(
  db: Database,
  serverId: string,
  categoryIds: string[]
) {
  if (categoryIds.length === 0) return [];
  const desired = db.$with("desired_category_order").as(
    db
      .select({
        id: sql<string>`CAST(value AS TEXT)`.as("id"),
        position: sql<number>`CAST(key AS INTEGER)`.as("position"),
      })
      .from(sql`json_each(${JSON.stringify(categoryIds)})`)
  );
  const desiredIds = db.select({ id: desired.id }).from(desired);
  const submittedCount = categoryIds.length;
  const uniqueCountMatches = sql`(
    SELECT COUNT(DISTINCT ${desired.id}) FROM ${desired}
  ) = ${submittedCount}`;
  const scopedCountMatches = sql`(
    SELECT COUNT(*)
    FROM ${communityCategory}
    WHERE ${communityCategory.serverId} = ${serverId}
      AND ${communityCategory.id} IN (${desiredIds})
  ) = ${submittedCount}`;

  return db
    .with(desired)
    .update(communityCategory)
    .set({
      position: sql<number>`(
        SELECT ${desired.position}
        FROM ${desired}
        WHERE ${desired.id} = ${communityCategory.id}
      )`,
    })
    .where(
      and(
        eq(communityCategory.serverId, serverId),
        inArray(communityCategory.id, desiredIds),
        uniqueCountMatches,
        scopedCountMatches
      )
    )
    .returning({ id: communityCategory.id, position: communityCategory.position });
}
