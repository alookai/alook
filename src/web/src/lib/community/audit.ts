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
  /** A bot joined a server via `alook server join --invite <link>` (owner-initiated CLI join). */
  BOT_JOINED_VIA_INVITE: "community.bot.joined_via_invite",
  BOT_FRIEND_REQUESTED: "community.bot.friend_requested",
  BOT_FRIEND_APPROVED: "community.bot.friend_approved",
  BOT_FRIEND_DENIED: "community.bot.friend_denied",
  /** Requester withdrew their own pending bot friend-request. */
  BOT_FRIEND_CANCELLED: "community.bot.friend_cancelled",
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

/**
 * `String(err)` on a `DrizzleQueryError` only prints "Failed query: ...
 * params: ..." — the actual driver failure (e.g. a NOT NULL/FOREIGN KEY/
 * UNIQUE constraint message) lives on `.cause` (drizzle-orm 0.44+) and was
 * getting silently dropped from `audit_write_failed` logs, making every
 * past occurrence undiagnosable. Walk the chain so it's captured.
 */
function causeChain(err: unknown): string[] {
  const messages: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      messages.push(current.message)
      current = (current as Error & { cause?: unknown }).cause
    } else {
      messages.push(String(current))
      break
    }
  }
  return messages
}

export function logAudit(db: Database, action: AuditAction): void {
  queries.communityAuditLog.logAction(db, action).catch((err) => {
    log.warn("audit_write_failed", {
      err: String(err),
      cause: causeChain(err).join(" <- "),
      action: action.action,
      serverId: action.serverId,
      targetType: action.targetType,
      targetId: action.targetId,
    })
  })
}
