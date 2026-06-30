import { eq, inArray, like, sql, and, ne } from "drizzle-orm";
import { user } from "../schema";
import type { Database } from "../index";
import { escapeLikePattern } from "../../utils/sql-like";

export async function getUser(db: Database, id: string) {
  const rows = await db.select().from(user).where(eq(user.id, id));
  return rows[0] ?? null;
}

export async function getUsersByIds(db: Database, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(user).where(inArray(user.id, ids));
}

export async function getUserByEmail(db: Database, email: string) {
  const rows = await db.select().from(user).where(eq(user.email, email));
  return rows[0] ?? null;
}

export async function getUserByNameCaseInsensitive(db: Database, name: string) {
  const rows = await db.select().from(user).where(like(user.name, name));
  return rows[0] ?? null;
}

export async function searchUsersByName(
  db: Database,
  name: string,
  opts?: { excludeUserId?: string; limit?: number },
) {
  const pattern = `%${escapeLikePattern(name)}%`;
  const conditions = [sql`${user.name} LIKE ${pattern} ESCAPE '\\'`];
  if (opts?.excludeUserId) {
    conditions.push(ne(user.id, opts.excludeUserId));
  }
  return db
    .select()
    .from(user)
    .where(and(...conditions))
    .limit(opts?.limit ?? 20);
}

export async function createUser(
  db: Database,
  data: { name: string; email: string }
) {
  const rows = await db
    .insert(user)
    .values({ name: data.name, email: data.email })
    .returning();
  return rows[0]!;
}

export async function updateUser(
  db: Database,
  id: string,
  data: { name: string; image: string | null }
) {
  const rows = await db
    .update(user)
    .set({ name: data.name, image: data.image, updatedAt: new Date().toISOString() })
    .where(eq(user.id, id))
    .returning();
  return rows[0] ?? null;
}
