import { queries, createLogger } from "@alook/shared"
import type { Database } from "@alook/shared"

const log = createLogger({ service: "community-audit" })

/**
 * Typed audit-action union. Keep string-value stable across releases — old
 * rows in `community_audit_log.action` reference these verbatim.
 *
 * Bot-related actions are listed here so a) new call-sites get compile-time
 * feedback if they typo an action name; b) analytics can enumerate them.
 * `changes` is a JSON-encoded string with action-specific fields.
 */
export const COMMUNITY_AUDIT_ACTIONS = {
  BOT_CREATED: "community.bot.created",
  BOT_UPDATED: "community.bot.updated",
  BOT_DELETED: "community.bot.deleted",
  BOT_ADDED_TO_SERVER: "community.bot.added_to_server",
  BOT_REMOVED_FROM_SERVER: "community.bot.removed_from_server",
  BOT_JOIN_REQUESTED: "community.bot.join_requested",
  BOT_JOIN_APPROVED: "community.bot.join_approved",
  BOT_JOIN_DENIED: "community.bot.join_denied",
  BOT_FRIEND_REQUESTED: "community.bot.friend_requested",
  BOT_FRIEND_APPROVED: "community.bot.friend_approved",
  BOT_FRIEND_DENIED: "community.bot.friend_denied",
  MESSAGE_AUTHORED_AS_BOT: "community.message.authored_as_bot",
} as const

type AuditAction = {
  /** Null for user-scoped rows (bot lifecycle, friend approvals). */
  serverId: string | null
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
