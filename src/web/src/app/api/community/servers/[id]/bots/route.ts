import { NextRequest } from "next/server"
import {
  queries,
  ROLES,
  WS_EVENTS,
  CommunityBotAddToServerRequestSchema,
  createLogger,
} from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { fanOutToServerMembers, broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

const log = createLogger({ service: "community-bots-server-add" })

/**
 * Add a bot to a server. Two paths, keyed by ownership + friendship:
 *   Path A — Owner-add. Caller owns the bot AND is a member → direct insert.
 *   Path B — Friend-of-bot-add. Caller is friends with the bot AND is a member
 *            → write approval-request DM card, no member row until owner
 *            approves.
 * Any other combination returns 404 (indistinguishable from "bot not found"
 * so a non-friend can't enumerate bot vs human targets).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id as string
  const [body, err] = await parseBody(req, CommunityBotAddToServerRequestSchema)
  if (err) return err

  const db = getDb(ctx.env.DB)

  const callerMember = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!callerMember) return writeError("not a member of this server", 403)

  // Target must be a live bot user row.
  const target = await queries.user.getUserInternal(db, body.botId)
  if (!target || target.isBot !== true || target.deletedAt !== null) {
    return writeError("bot not found", 404)
  }
  const botId = target.id
  const ownerId = target.ownerUserId

  // Path A — Owner-add.
  if (ownerId === ctx.userId) {
    const already = await queries.communityMember.getMember(db, serverId, botId)
    if (already) {
      return writeJSON({ status: "added" }, 201)
    }
    const added = await queries.communityMember.addMember(db, {
      serverId,
      userId: botId,
      role: ROLES.MEMBER,
    })
    logAudit(db, {
      serverId,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_ADDED_TO_SERVER,
      targetType: "user",
      targetId: botId,
      changes: JSON.stringify({ botId, serverId, kind: "owner_added" }),
    })
    const bot = await queries.user.getUserSelf(db, botId)
    const joinEvent: CommunityMemberJoin = {
      type: WS_EVENTS.MEMBER_JOIN,
      serverId,
      member: {
        id: added.id,
        userId: botId,
        name: bot?.name ?? "",
        avatar: bot?.image ?? undefined,
        role: added.role ?? ROLES.MEMBER,
        joinedAt: added.joinedAt,
      },
    }
    fanOutToServerMembers(serverId, joinEvent, { excludeUserId: ctx.userId })
    return writeJSON({ status: "added" }, 201)
  }

  // Path B — Friend-of-bot-add. Caller must be friends with the BOT (not the
  // owner). Otherwise 404 for pass-as-human indistinguishability.
  const friends = await queries.communityFriendship.areFriends(db, ctx.userId, botId)
  if (!friends) return writeError("bot not found", 404)
  if (!ownerId) return writeError("bot not found", 404)

  // Idempotency — same friend re-requesting for same (bot, server). The
  // partial unique guards at DB level but we check first to keep the response
  // shape identical (no duplicate DM card).
  const pending = await queries.communityBot.findPendingJoinRequest(db, botId, serverId)
  if (pending) return writeJSON({ status: "pending" }, 200)

  // Owner ↔ bot DM (may need to be created).
  const dm = await queries.communityDm.createOrGetDM(db, {
    userId1: botId,
    userId2: ownerId,
  })

  // Compose the DM card content. Fall back to a generic phrase when the
  // caller has no server nickname — never leak a raw nickname of "" or the
  // string "undefined".
  const requesterLabel = callerMember.nickname?.trim() || "A friend"
  const botName = target.name || "the bot"
  const msg = await queries.communityMessage.createMessage(db, {
    authorId: botId,
    content: `${requesterLabel} wants to add me to a server. Approve?`,
    dmConversationId: dm.id,
    type: "default",
  })
  // Write the approval-request row. If the partial unique index rejects a
  // concurrent duplicate, roll back by hard-deleting the DM card so the owner
  // never sees a phantom card without approve/deny buttons.
  try {
    await queries.communityBot.createApprovalRequestStatement(db, {
      botId,
      kind: "join_server",
      serverId,
      requestedByUserId: ctx.userId,
      dmMessageId: msg.id,
    })
  } catch (err) {
    // Race lost or transient — compensate by deleting the DM card so the
    // owner never sees an unactionable card. If the compensating delete
    // ALSO fails we've left an orphan; surface 500 so the caller retries
    // (idempotency on the partial-unique will short-circuit on retry).
    try {
      await queries.communityMessage.hardDeleteMessage(db, msg.id)
    } catch (rollbackErr) {
      log.error("approval_request_rollback_failed", {
        botId,
        serverId,
        messageId: msg.id,
        insertErr: String(err),
        rollbackErr: String(rollbackErr),
      })
      return writeError("approval request write failed", 500)
    }
    // Race lost — the peer request already exists. Report pending to keep
    // the caller-facing shape identical to the idempotent case above.
    return writeJSON({ status: "pending" }, 200)
  }

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_JOIN_REQUESTED,
    targetType: "user",
    targetId: botId,
    changes: JSON.stringify({ botId, serverId, requestedByUserId: ctx.userId }),
  })

  // Fan-out the DM to the owner so their DM view updates.
  broadcastToUserSafe(ownerId, {
    type: WS_EVENTS.DM_NEW_MESSAGE,
    dmConversationId: dm.id,
    message: {
      id: msg.id,
      authorId: botId,
      authorName: botName,
      content: msg.content,
      createdAt: msg.createdAt,
    },
  })

  return writeJSON({ status: "pending" }, 200)
})
