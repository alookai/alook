import { eq, and, gt, isNull } from "drizzle-orm";
import { session, user } from "../schema";
import type { Database } from "../index";

export async function getValidSession(db: Database, token: string) {
  const rows = await db
    .select({ userId: session.userId })
    .from(session)
    .where(
      and(
        eq(session.token, token),
        gt(session.expiresAt, new Date().toISOString())
      )
    );
  if (rows.length === 0) return null;
  return rows[0].userId;
}

export async function getValidSessionWithIdentity(
  db: Database,
  token: string
): Promise<{ userId: string; name: string; discriminator: string; sessionId: string; expiresAt: string } | null> {
  const rows = await db
    .select({
      userId: session.userId,
      name: user.name,
      discriminator: user.discriminator,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.token, token),
        isNull(user.deletedAt),
        eq(user.isBot, false),
        gt(session.expiresAt, new Date().toISOString())
      )
    );
  if (rows.length === 0) return null;
  return rows[0];
}

export async function getValidSessionByIdForUser(db: Database, id: string, userId: string) {
  const [row] = await db.select({ expiresAt: session.expiresAt }).from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.id, id), eq(session.userId, userId),
      gt(session.expiresAt, new Date().toISOString()), isNull(user.deletedAt), eq(user.isBot, false)))
    .limit(1);
  return row ?? null;
}
