import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isServerOwner, parseNameAndTag, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe, fanOutToServerMembers } from "@/lib/community/fanout"
import { requireServerMember } from "@/lib/community/permissions"

const REF_PLACEHOLDER_ID = "resolve"

export const POST = withCommunityActor(async (req, ctx) => {
  const pathServerId = ctx.params?.id
  if (!pathServerId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const userId = ctx.actor.userId
  let serverId = pathServerId

  if (ctx.actor.kind === "bot") {
    if (pathServerId !== REF_PLACEHOLDER_ID) {
      return writeError("bots must leave a server by handle", 403)
    }
    const serverRef = req.nextUrl.searchParams.get("server")
    if (!serverRef) return writeError("missing server query param", 400)
    if (!parseNameAndTag(serverRef)) {
      return writeError("invalid server handle, expected name#0042", 400)
    }
    const servers = await queries.communityServer.resolveServerByNameForMember(db, userId, serverRef)
    if (servers.length === 0) return writeError(`server not found: ${serverRef}`, 404)
    serverId = servers[0]!.id
  }

  // Verify user is a member
  const auth = await requireServerMember(db, serverId, userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const member = auth.value

  // Owner cannot leave (must delete server instead)
  if (isServerOwner(member.role)) {
    return writeError("owner cannot leave the server, delete it instead", 400)
  }

  // Owner-leaves-server cascade: their live bots that are members of this
  // server are removed too. See §Owner-leaves-server cascade in plan.
  const botIdsToCascade = await queries.communityMember.listOwnerBotsInServer(
    db,
    serverId,
    userId,
  )

  const removed = await queries.communityMember.removeMemberAndOwnerBots(
    db,
    member.id,
    serverId,
    userId,
    botIdsToCascade,
  )
  if (!removed) return writeError("member not found", 404)

  const viewerLeaveEvent = {
    type: WS_EVENTS.MEMBER_LEAVE,
    serverId,
    userId,
  } as const
  const botLeaveEvents = botIdsToCascade.map((botId) => ({
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: botId,
  } as const))

  await Promise.all([
    fanOutToServerMembers(serverId, viewerLeaveEvent),
    broadcastToUserSafe(userId, viewerLeaveEvent),
    ...botLeaveEvents.flatMap((event) => [
      fanOutToServerMembers(serverId, event),
      broadcastToUserSafe(event.userId, event),
    ]),
  ])

  return new Response(null, { status: 204 })
})
