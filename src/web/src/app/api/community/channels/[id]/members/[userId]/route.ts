import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS, isThread, DM_SERVER, parseRef } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireChannelAccess } from "@/lib/community/permissions"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"

const REF_PLACEHOLDER_ID = "resolve"

/**
 * Remove a member from a private access unit (channel).
 *   - Self-leave: any member may remove THEMSELVES (drop their own access).
 *   - Remove others: CREATOR only (add is open to members, but evicting someone
 *     else is the creator's call; admins have no content privilege here).
 *   - A creator may self-leave after deterministic creator handoff. Removing
 *     another current creator remains out of scope.
 * The removed user gets a CHANNEL_MEMBER_REMOVE so their sidebar drops the
 * channel + evicts its caches.
 */
export const DELETE = withCommunityActor(async (req: NextRequest, ctx) => {
  const pathChannelId = ctx.params?.id
  const pathTargetUserId = ctx.params?.userId
  if (!pathChannelId || !pathTargetUserId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  let channelId = pathChannelId
  let targetUserId = pathTargetUserId

  if (ctx.actor.kind === "bot") {
    if (pathChannelId !== REF_PLACEHOLDER_ID || pathTargetUserId !== "self") {
      return writeError("bots may only leave themselves by channel ref", 403)
    }
    const ref = req.nextUrl.searchParams.get("ref")
    if (!ref) return writeError("channel ref required", 400)
    let parsed: ReturnType<typeof parseRef> | undefined
    try {
      parsed = parseRef(ref)
    } catch {
      parsed = undefined
    }
    if (parsed?.server === DM_SERVER) return writeError("DMs cannot be left", 400)
    const resolved = await resolveTargetForMember(db, ctx.actor.userId, ref, {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    if ("error" in resolved) return writeError(resolved.message, resolved.error)
    if (resolved.kind === "dm") return writeError("DMs cannot be left", 400)
    channelId = resolved.channelId
    targetUserId = ctx.actor.userId
  }

  const access = await requireChannelAccess(db, channelId, ctx.actor.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const channel = access.value.channel
  if (isThread(channel.type) || channel.parentMessageId) {
    return writeError("threads inherit their parent's members — remove participants instead", 400)
  }
  if (!access.value.isPrivate) {
    return writeError("public channels cannot be left independently — leave the server instead", 400)
  }
  const isSelf = targetUserId === ctx.actor.userId
  if (channel.creatorId === targetUserId && !isSelf) {
    return writeError("can't remove the channel creator", 400)
  }
  // Self-leave is always allowed; removing anyone else is creator-only.
  if (!isSelf && !access.value.isCreator) return writeError("forbidden", 403)

  const removed = await queries.communityChannel.deleteChannelMemberAndChildParticipants(
    db,
    channelId,
    targetUserId,
  )
  if (!removed) return writeError("member not found", 404)

  const event = {
    type: WS_EVENTS.CHANNEL_MEMBER_REMOVE,
    serverId: channel.serverId,
    channelId,
    userId: targetUserId,
  } as const
  // Notify the removed user (drop the channel) plus the remaining audience.
  const recipients = await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
  await Promise.all(
    [...new Set([...recipients, targetUserId])].map((uid) => broadcastToUserSafe(uid, event))
  )


  return new Response(null, { status: 204 })
})
