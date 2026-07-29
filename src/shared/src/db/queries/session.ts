import { eq, and, gt } from "drizzle-orm";
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

/**
 * Like `getValidSession`, but also returns the user's display `name` +
 * `discriminator` (one join to `user`). Used by the WS-auth handshake so the
 * connection state can carry the name and typing fan-out stamps it into the
 * event WITHOUT a per-event DB lookup (see the "Unknown member is typing" fix).
 * Runs once per WS connection at auth, not on the hot typing path.
 */
export async function getValidSessionWithIdentity(
  db: Database,
  token: string
): Promise<{ userId: string; name: string; discriminator: string } | null> {
  const rows = await db
    .select({
      userId: session.userId,
      name: user.name,
      discriminator: user.discriminator,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.token, token),
        gt(session.expiresAt, new Date().toISOString())
      )
    );
  if (rows.length === 0) return null;
  return rows[0];
}
