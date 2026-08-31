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
 * Leave a thread (remove a participant row). The viewer may remove
 * THEMSELVES; the unit creator may remove anyone. Thread only. A later
 * mention/speak re-adds a user who left.
 *
 * (Muting is NOT here — that's the outer channel-header notification level,
 * per-layer, same control a channel uses. Participation is add/leave only.)
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
  const type = access.value.channel.type
  if (!isThread(type)) {
    return writeError("not a thread", 400)
  }

  // Removing another participant is the UNIT creator's call — the person who
  // started the thread (`channel.creatorId`), NOT `access.value.isCreator`,
  // which resolves to the parent channel/forum's creator (the access anchor).
  // Any participant may always remove themselves.
  const isSelf = targetUserId === ctx.actor.userId
  const isUnitCreator = access.value.channel.creatorId === ctx.actor.userId
  if (!isSelf && !isUnitCreator) return writeError("forbidden", 403)

  const removed = await queries.communityChannel.deleteThreadParticipantWithCreatorHandoff(
    db,
    channelId,
    targetUserId,
  )
  if (!removed) return writeError("participant not found", 404)
  const event = {
    type: WS_EVENTS.CHANNEL_MEMBER_REMOVE,
    serverId: access.value.channel.serverId,
    channelId,
    userId: targetUserId,
  } as const
  const remaining = await queries.communityThread.listThreadParticipantUserIds(db, channelId)
  await Promise.all(
    [...new Set([...remaining, targetUserId])].map((userId) =>
      broadcastToUserSafe(userId, event),
    ),
  )
  return new Response(null, { status: 204 })
})
