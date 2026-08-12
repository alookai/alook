import { NextRequest, NextResponse } from "next/server"
import {
  queries,
  parseNameAndTag,
  isBlocked,
  CommunityAgentFriendRequestSchema,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import type { BotActor, CommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireNotBlocked } from "@/lib/community/permissions"

/**
 * POST /api/community/friends/request — the friend-request door (route/disc
 * 接口树统一, friendRequest fold; Melly #540). Dual-actor via withCommunityActor,
 * dispatched by actor.kind to TWO INDEPENDENT handlers that share ONLY the URL +
 * the gate — NOT one handler with shared-middle if-branches (that would flatten
 * the two distinct semantics; Ingaborg #539/#542 reds cross-contamination):
 *   - human → handleHumanFriendRequest: {userId|username}, direct send, returns
 *     the FULL friendship (201, or 200 on auto-accept). Byte-identical to the
 *     former withAuth route — NO owner-gate. KEEPS its isBot→403 backstop
 *     (Aigneis #541): the human arm auto-accepts (no owner gate), so if the
 *     dispatch ever had a seam that let a bot reach here, the bot would bypass
 *     owner-approval and directly auto-friend = capability escalation. Dispatch
 *     is the main gate; isBot→403 is the last-line backstop. BOTH stay.
 *   - bot → handleBotFriendRequest: {username} (name#tag only), sibling-bot
 *     auto-accept, ALWAYS owner-gated (needsOwnerApproval, never dropped), lean
 *     {friendshipId,status,hint} response. Folds the flat /friendRequest bot
 *     verb (flat verb deleted at
 *     the flat-delete step). Self-scoped: requesterId = the credential's
 *     botUserId, never a body field.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  if (ctx.actor.kind === "bot") {
    return handleBotFriendRequest(req, ctx.env, ctx.actor)
  }
  return handleHumanFriendRequest(req, ctx.env, ctx.actor)
})

async function handleHumanFriendRequest(
  req: NextRequest,
  env: Env,
  actor: Extract<CommunityActor, { kind: "human" }>,
): Promise<NextResponse> {
  const db = getDb(env.DB)

  // Belt-and-suspenders backstop (Aigneis #541 — MUST survive the dual-actor
  // fold, NOT redundant): the actor-gate dispatch is the main door (a bot routes
  // to handleBotFriendRequest, never here), but this human arm AUTO-ACCEPTS (200,
  // no owner gate) — if the dispatch ever had a seam that let a bot reach here,
  // the bot would bypass owner-approval and directly auto-friend = capability
  // escalation. So keep the last-line isBot→403 even with the gate above.
  // (Always false in production — a bot session is rejected at 401 before any
  // handler runs; this is the future-auth-regression backstop.) See
  // plans/agent-friendship-approval-gate.md §Hardening.
  if (actor.isBot) return writeError("forbidden", 403)

  let body: { userId?: string; username?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  let targetUserId = body.userId
  if (!targetUserId && body.username) {
    const handle = parseNameAndTag(body.username)
    const targetUser = handle
      ? await queries.user.getUserByNameAndDiscriminator(db, handle.name, handle.discriminator)
      : await queries.user.getUserByNameCaseInsensitive(db, body.username)
    if (!targetUser) return writeError("user not found", 404)
    targetUserId = targetUser.id
  }

  if (!targetUserId) {
    return writeError("userId or username is required", 400)
  }

  if (targetUserId === actor.userId) {
    return writeError("cannot send friend request to yourself", 400)
  }

  const target = await queries.user.getUserInternal(db, targetUserId)
  if (!target || target.deletedAt !== null) return writeError("user not found", 404)

  // Owner ↔ own-bot is a synthetic friendship — no row can exist. 409 so the UI
  // treats it as a no-op.
  if (target.isBot === true && target.ownerUserId === actor.userId) {
    return writeError("already friends", 409)
  }

  const block = await requireNotBlocked(db, actor.userId, targetUserId)
  if (!block.ok) return writeError(block.error, block.status)

  try {
    const result = await queries.communityFriendship.sendRequest(db, {
      requesterId: actor.userId,
      addresseeId: targetUserId,
    })
    // The query owns supersede + card writes + broadcast payloads; the route
    // just relays them.
    for (const b of result.broadcasts) {
      await broadcastToUserSafe(b.userId, b.event)
    }
    if (result.kind === "auto_accepted") {
      return writeJSON(result.friendship, 200)
    }
    return writeJSON(result.friendship, 201)
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (isBlocked(err.message)) return writeError("blocked", 403)
      if (err.message === "already friends") return writeError("already friends", 409)
      if (err.message === "friend request already sent") {
        return writeError("friend request already sent", 409)
      }
    }
    throw err
  }
}

async function handleBotFriendRequest(
  req: NextRequest,
  env: Env,
  bot: BotActor,
): Promise<NextResponse> {
  const { userId: botUserId, ownerUserId } = bot
  const db = getDb(env.DB)

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

  // Bot-origin sendRequest always sets needsOwnerApproval, so this is always
  // the pending variant. Resolve the owner's display name for the hint copy.
  const owner = await queries.user.getUserPublic(db, ownerUserId)
  const ownerDisplayName = owner?.name ?? "your owner"
  return NextResponse.json({
    friendshipId: result.friendship.id,
    status: "pending",
    hint: `Your owner ${ownerDisplayName} needs to approve this request in DM.`,
  })
}
