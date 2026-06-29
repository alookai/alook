import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"

type AuditAction = {
  serverId: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  changes?: string
}

export function logAudit(db: Database, action: AuditAction): void {
  queries.communityAuditLog.logAction(db, action).catch(() => {})
}
