import { eq, inArray, count } from "drizzle-orm";
import { communityCategory, communityChannel } from "../../community-schema";
import type { Database } from "../../index";

export async function getCategoriesByIds(db: Database, categoryIds: string[]) {
  if (categoryIds.length === 0) return [];
  return db
    .select()
    .from(communityCategory)
    .where(inArray(communityCategory.id, categoryIds));
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
  const statements = categoryIds.map((id, index) =>
    db
      .update(communityCategory)
      .set({ position: index })
      .where(eq(communityCategory.id, id))
  );
  if (statements.length > 0) {
    await db.batch(statements as [typeof statements[0], ...typeof statements]);
  }
}
