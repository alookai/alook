import { NextResponse, type NextRequest } from "next/server"
import {
  queries,
  CommunityAgentFriendRequestSchema,
  parseNameAndTag,
  isBlocked,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { requireNotBlocked } from "@/lib/community/permissions"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * POST /api/community/agent/friendRequest — agent-initiated friend request.
 * Body `{ username: "name#0042" }`. Identity is the bearer voucher (bot). All
 * bot-origin requests are owner-gated except sibling-bot targets (same owner),
 * which auto-accept. See plans/agent-friendship-approval-gate.md §Route 1.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
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
  if (target.id === ctx.botUserId) {
    return NextResponse.json({ error: "cannot friend yourself" }, { status: 400 })
  }
  if (target.id === ctx.ownerUserId) {
    // Owner ↔ bot is synthetic; no row can exist.
    return NextResponse.json({ error: "already friends", code: "already_friends" }, { status: 409 })
  }

  // Resolve internal flags to detect the sibling-bot case.
  const targetInternal = await queries.user.getUserInternal(db, target.id)
  if (!targetInternal || targetInternal.deletedAt !== null) {
    return NextResponse.json({ error: "user not found" }, { status: 404 })
  }

  // Sibling auto-accept branch (design step 5).
  if (targetInternal.isBot === true && targetInternal.ownerUserId === ctx.ownerUserId) {
    const block = await requireNotBlocked(db, ctx.botUserId, target.id)
    if (!block.ok) return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })

    const result = await queries.communityFriendship.ensureSiblingBotFriendship(db, {
      botA: ctx.botUserId,
      botB: target.id,
    })
    if (result.blocked) {
      return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })
    }
    return NextResponse.json({ friendshipId: result.friendshipId, status: "accepted", hint: null })
  }

  // Belt-and-suspenders (sendRequest also checks).
  const block = await requireNotBlocked(db, ctx.botUserId, target.id)
  if (!block.ok) return NextResponse.json({ error: "blocked", code: "blocked" }, { status: 403 })

  let result
  try {
    result = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.botUserId,
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
    actorId: ctx.botUserId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_REQUESTED,
    targetType: "user",
    targetId: target.id,
    changes: JSON.stringify({ requesterBotId: ctx.botUserId, addresseeId: target.id }),
  })
  for (const supersededId of result.supersededIds) {
    logAudit(db, {
      serverId: null,
      actorId: ctx.botUserId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_REQUEST_SUPERSEDED,
      targetType: "friendship",
      targetId: supersededId,
      changes: JSON.stringify({ supersededBy: result.friendship.id }),
    })
  }

  // Bot-origin sendRequest always sets needsOwnerApproval, so this is always
  // the pending variant. Resolve the owner's display name for the hint copy.
  const owner = await queries.user.getUserPublic(db, ctx.ownerUserId)
  const ownerDisplayName = owner?.name ?? "your owner"
  return NextResponse.json({
    friendshipId: result.friendship.id,
    status: "pending",
    hint: `Your owner ${ownerDisplayName} needs to approve this request in DM.`,
  })
})
