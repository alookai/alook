import { NextResponse, type NextRequest } from "next/server"
import {
  queries,
  CommunityAgentFriendRequestSchema,
  parseNameAndTag,
  isBlocked,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { requireNotBlocked } from "@/lib/community/permissions"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * POST /api/community/friendRequest — moved from
 * /api/community/agent/friendRequest (plan §4, §9 phase 4). MOVE-FLAT, not FOLD
 * onto POST /friends/request: the bot flow has DIFFERENT semantics — sibling-bot
 * auto-accept, always-owner-gated (needsOwnerApproval), and a lean
 * `{friendshipId, status, hint}` response — vs the human route's direct
 * send + full-friendship response. Per the plan's judgment rule (Melly #113:
 * different semantics → keep distinct under the unified actor), and matching
 * batch1 which kept friendRequest as a distinct RPC. Bot-only → human actor
 * rejected 403 (the human uses /friends/request, which itself already rejects
 * bots). Audit BOT_FRIEND_REQUESTED / BOT_FRIEND_REQUEST_SUPERSEDED preserved
 * (§6). Body unchanged from the /agent original except wrapper + identity.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId, ownerUserId } = gate.bot

  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentFriendRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 })
  }

  // Only the human `name#0042` handle is accepted.
  const handle = parseNameAndTag(parsed.data.username)
  if (!handle) {
    return NextResponse.json({ error: "username must be in name#0042 form" }, { status: 400 })
  }
  const target = await queries.user.getUserByNameAndDiscriminator(db, handle.name, handle.discriminator)
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 })

  // Guards in order (design steps 3–4).
  if (target.id === botUserId) {
    return NextResponse.json({ error: "cannot friend yourself" }, { status: 400 })
  }
  if (target.id === ownerUserId) {
    // Owner ↔ bot is synthetic; no row can exist.
    return NextResponse.json({ error: "already friends", code: "already_friends" }, { status: 409 })
  }

  // Resolve internal flags to detect the sibling-bot case.
  const targetInternal = await queries.user.getUserInternal(db, target.id)
  if (!targetInternal || targetInternal.deletedAt !== null) {
    return NextResponse.json({ error: "user not found" }, { status: 404 })
  }

  // Sibling auto-accept branch (design step 5).
  if (targetInternal.isBot === true && targetInternal.ownerUserId === ownerUserId) {
    const block = await requireNotBlocked(db, botUserId, target.id)
    if (!block.ok) return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })

    const result = await queries.communityFriendship.ensureSiblingBotFriendship(db, {
      botA: botUserId,
      botB: target.id,
    })
    if (result.blocked) {
      return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })
    }
    return NextResponse.json({ friendshipId: result.friendshipId, status: "accepted", hint: null })
  }

  // Belt-and-suspenders (sendRequest also checks).
  const block = await requireNotBlocked(db, botUserId, target.id)
  if (!block.ok) return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })

  let result
  try {
    result = await queries.communityFriendship.sendRequest(db, {
      requesterId: botUserId,
      addresseeId: target.id,
    })
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (isBlocked(err.message)) {
        return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })
      }
      if (err.message === "already friends") {
        return NextResponse.json({ error: "already friends", code: "already_friends" }, { status: 409 })
      }
      if (err.message === "friend request already sent") {
        return NextResponse.json(
          { error: "friend request already sent", code: "friend_request_already_sent" },
          { status: 409 },
        )
      }
    }
    throw err
  }

  for (const b of result.broadcasts) {
    await broadcastToUserSafe(b.userId, b.event)
  }

  logAudit(db, {
    serverId: null,
    actorId: botUserId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_REQUESTED,
    targetType: "user",
    targetId: target.id,
    changes: JSON.stringify({ requesterBotId: botUserId, addresseeId: target.id }),
  })
  for (const supersededId of result.supersededIds) {
    logAudit(db, {
      serverId: null,
      actorId: botUserId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_REQUEST_SUPERSEDED,
      targetType: "friendship",
      targetId: supersededId,
      changes: JSON.stringify({ supersededBy: result.friendship.id }),
    })
  }

  // Bot-origin sendRequest always sets needsOwnerApproval, so this is always
  // the pending variant. Resolve the owner's display name for the hint copy.
  const owner = await queries.user.getUserPublic(db, ownerUserId)
  const ownerDisplayName = owner?.name ?? "your owner"
  return NextResponse.json({
    friendshipId: result.friendship.id,
    status: "pending",
    hint: `Your owner ${ownerDisplayName} needs to approve this request in DM.`,
  })
})
