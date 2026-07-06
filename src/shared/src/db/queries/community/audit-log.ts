import { eq, and, desc, lt } from "drizzle-orm";
import { communityAuditLog } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const DEFAULT_LIMIT = 50;

export async function logAction(
  db: Database,
  data: {
    /** Null for user-scoped rows (bot lifecycle, friend approvals). */
    serverId: string | null;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    changes?: string;
    reason?: string;
  }
) {
  const [row] = await db
    .insert(communityAuditLog)
    .values({
      serverId: data.serverId,
      actorId: data.actorId,
      action: data.action,
      targetType: data.targetType,
      targetId: data.targetId,
      changes: data.changes ?? null,
      reason: data.reason ?? null,
    })
    .returning();
  return row!;
}

export async function listAuditLog(
  db: Database,
  serverId: string,
  opts?: { action?: string; before?: string; limit?: number }
) {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const conditions = [eq(communityAuditLog.serverId, serverId)];

  if (opts?.action) {
    conditions.push(eq(communityAuditLog.action, opts.action));
  }

  if (opts?.before) {
    conditions.push(lt(communityAuditLog.createdAt, opts.before));
  }

  return db
    .select({
      log: communityAuditLog,
      // Project only the fields needed to render audit log entries — never
      // leak full user PII (email, etc.) to server admins.
      actor: {
        id: user.id,
        name: user.name,
        image: user.image,
      },
    })
    .from(communityAuditLog)
    .leftJoin(user, eq(communityAuditLog.actorId, user.id))
    .where(and(...conditions))
    .orderBy(desc(communityAuditLog.createdAt))
    .limit(limit);
}
