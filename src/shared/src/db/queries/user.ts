import { eq, isNull, and } from "drizzle-orm";
import { user } from "../schema";
import type { Database } from "../index";

export async function getUser(db: Database, id: string) {
  const rows = await db.select().from(user).where(eq(user.id, id));
  return rows[0] ?? null;
}

export async function getUserByEmail(db: Database, email: string) {
  const rows = await db.select().from(user).where(eq(user.email, email));
  return rows[0] ?? null;
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

export async function updateRegistrationSource(
  db: Database,
  id: string,
  data: {
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    referrer?: string | null;
  }
) {
  const rows = await db
    .update(user)
    .set({
      utmSource: data.utmSource ?? null,
      utmMedium: data.utmMedium ?? null,
      utmCampaign: data.utmCampaign ?? null,
      referrer: data.referrer ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(user.id, id),
        isNull(user.utmSource),
        isNull(user.utmMedium),
        isNull(user.utmCampaign),
        isNull(user.referrer),
      )
    )
    .returning();
  return rows[0] ?? null;
}
