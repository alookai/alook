import { NextRequest } from "next/server"
import {
  queries,
  withD1Retry,
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
import { createCommunityMessage } from "@/lib/community/message-handler"

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

  // `withD1Retry` (D1-armor state 2): membership access-check — a transient
  // would 403 a real member; retry to truth.
  const callerMember = await withD1Retry(
    () => queries.communityMember.getMember(db, serverId, ctx.userId),
    { route: "servers/bots/caller-member" },
  )
  if (!callerMember) return writeError("not a member of this server", 403)

  // Target must be a live bot user row.
  // `withD1Retry` (D1-armor state 2): a transient would 404 a real bot target.
  const target = await withD1Retry(() => queries.user.getUserInternal(db, body.botId), {
    route: "servers/bots/target",
  })
  if (!target || target.isBot !== true || target.deletedAt !== null) {
    return writeError("bot not found", 404)
  }
  const botId = target.id
  const ownerId = target.ownerUserId

  // Path A — Owner-add.
  if (ownerId === ctx.userId) {
    // `withD1Retry` (D1-armor state 2): idempotency pre-check; retry to truth.
    const already = await withD1Retry(
      () => queries.communityMember.getMember(db, serverId, botId),
      { route: "servers/bots/already-member" },
    )
    if (already) {
      return writeJSON({ status: "added" }, 201)
    }
    // `withD1Retry` (D1-armor state 3): double-add is blocked by the
    // uq_server_member (server_id,user_id) unique — a retried transient that
    // already committed rethrows the (non-retryable) UNIQUE, so it never adds a
    // second member row. (The get-first above already covers the common repeat.)
    const added = await withD1Retry(
      () =>
        queries.communityMember.addMember(db, {
          serverId,
          userId: botId,
          role: ROLES.MEMBER,
        }),
      { route: "servers/bots/add-member" },
    )
    logAudit(db, {
      serverId,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_ADDED_TO_SERVER,
      targetType: "user",
      targetId: botId,
      changes: JSON.stringify({ botId, serverId, kind: "owner_added" }),
    })
    // `withD1Retry` (D1-armor state 2): read for the MEMBER_JOIN broadcast
    // payload; retry to truth (falls back to "" only on a genuine null).
    const bot = await withD1Retry(() => queries.user.getUserSelf(db, botId), {
      route: "servers/bots/join-bot-self",
    })
    const joinEvent: CommunityMemberJoin = {
      type: WS_EVENTS.MEMBER_JOIN,
      serverId,
      member: {
        id: added.id,
        userId: botId,
        name: bot?.name ?? "",
        discriminator: bot?.discriminator ?? "0000",
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
  // `withD1Retry` (D1-armor state 2): friendship access-gate — a transient would
  // 404 a legitimate friend-add (mis-judged state); retry to truth.
  const friends = await withD1Retry(
    () => queries.communityFriendship.areFriends(db, ctx.userId, botId),
    { route: "servers/bots/are-friends" },
  )
  if (!friends) return writeError("bot not found", 404)
  if (!ownerId) return writeError("bot not found", 404)

  // Idempotency — same friend re-requesting for same (bot, server). The
  // partial unique guards at DB level but we check first to keep the response
  // shape identical (no duplicate DM card).
  // `withD1Retry` (D1-armor state 2): idempotency pre-check for the DM card;
  // retry to truth.
  const pending = await withD1Retry(
    () => queries.communityBot.findPendingJoinRequest(db, botId, serverId),
    { route: "servers/bots/find-pending" },
  )
  if (pending) return writeJSON({ status: "pending" }, 200)

  // Owner ↔ bot DM (may need to be created).
  // `withD1Retry` (D1-armor state 3): get-first — returns the existing DM
  // channel when present, so a retried transient re-resolves the same channel.
  // (There is no unique on the DM pair; the concurrent-double-create edge is the
  // tracked DM double-create backlog item, not introduced here.)
  const dm = await withD1Retry(
    () => queries.communityDm.createOrGetDM(db, { userId1: botId, userId2: ownerId }),
    { route: "servers/bots/create-or-get-dm" },
  )

  // Compose the DM card content. Fall back to a generic phrase when the
  // caller has no display name — never leak a raw name of "" or the string
  // "undefined".
  // `withD1Retry` (D1-armor state 2): caller display name for the card copy;
  // retry to truth (falls back to "A friend" only on a genuine null).
  const caller = await withD1Retry(() => queries.user.getUserSelf(db, ctx.userId), {
    route: "servers/bots/caller-self",
  })
  const requesterLabel = caller?.name?.trim() || "A friend"
  const botName = target.name || "the bot"
  // Unified pipeline, broadcast-deferred: the card must not reach the owner
  // until the approval-request row commits (a rollback below would otherwise
  // leave a phantom, unactionable card). `skipMentions`/`skipWake` — a bot DM
  // card mentions no one and wakes no one. The returned `broadcast` thunk is
  // never invoked; this route fires its own minimal `MESSAGE_CREATE` after the
  // approval row persists.
  const created = await createCommunityMessage({
    db,
    authorId: botId,
    target: { kind: "dm", channelId: dm.id, otherUserId: ownerId },
    body: { content: `${requesterLabel} wants to add me to a server. Approve?` },
    skipMentions: true,
    skipWake: true,
    deferBroadcast: true,
  })
  if (!created.ok) return writeError(created.error, created.status)
  const msg = created.row
  // Write the approval-request row. If the partial unique index rejects a
  // concurrent duplicate, roll back by hard-deleting the DM card so the owner
  // never sees a phantom card without approve/deny buttons.
  try {
    // `withD1Retry` (D1-armor state 3): double-request is blocked by the partial
    // unique uq_community_bot_approval_pending_join (bot_id, server_id WHERE
    // kind='join_server' AND status='pending'). A retried transient re-runs the
    // insert; a real concurrent duplicate surfaces as a non-retryable constraint
    // that withD1Retry rethrows straight into the catch below — which rolls back
    // the DM card and returns "pending". So retry absorbs the blip without ever
    // creating a second approval row or leaving a phantom card.
    await withD1Retry(
      () =>
        queries.communityBot.createApprovalRequestStatement(db, {
          botId,
          kind: "join_server",
          serverId,
          requestedByUserId: ctx.userId,
          dmMessageId: msg.id,
        }),
      { route: "servers/bots/create-approval" },
    )
  } catch (err) {
    // Race lost or transient — compensate by deleting the DM card so the
    // owner never sees an unactionable card. If the compensating delete
    // ALSO fails we've left an orphan; surface 500 so the caller retries
    // (idempotency on the partial-unique will short-circuit on retry).
    try {
      // `withD1Retry` (D1-armor state 3): idempotent (get-first — a re-run on an
      // already-deleted message is a no-op), so retry the compensating delete
      // before giving up and leaving an orphan card.
      await withD1Retry(() => queries.communityMessage.hardDeleteMessage(db, msg.id), {
        route: "servers/bots/rollback-delete",
      })
    } catch (rollbackErr) {
      log.error("approval_request_rollback_failed", {
        botId,
        serverId,
        messageId: msg.id,
        insertErr: String(err),
        rollbackErr: String(rollbackErr),
      })
      return writeError(
        `approval request write failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        500
      )
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

  // Fan-out the DM to the owner so their DM view updates. DMs are channels
  // now — key the MESSAGE_CREATE by the DM's channel id.
  broadcastToUserSafe(ownerId, {
    type: WS_EVENTS.MESSAGE_CREATE,
    channelId: dm.id,
    message: {
      id: msg.id,
      authorId: botId,
      authorName: botName,
      content: msg.content,
      type: "chat",
      createdAt: msg.createdAt,
    },
  })

  return writeJSON({ status: "pending" }, 200)
})
