import { queries, createLogger } from "@alook/shared"
import type { Database } from "@alook/shared"

const log = createLogger({ service: "community-audit" })

type AuditAction = {
  serverId: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  changes?: string
}

export function logAudit(db: Database, action: AuditAction): void {
  queries.communityAuditLog.logAction(db, action).catch((err) => {
    log.warn("audit_write_failed", {
      err: String(err),
      action: action.action,
      serverId: action.serverId,
      targetType: action.targetType,
      targetId: action.targetId,
    })
  })
}
