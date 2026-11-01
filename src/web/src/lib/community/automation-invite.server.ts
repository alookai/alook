import type { NextRequest } from "next/server"
import { queries, parseNameAndTag, formatHandle, MAX_ACTIVE_INVITES_PER_SERVER, WS_EVENTS } from "@alook/shared"
import { z } from "zod"
import { getPrimaryDb } from "@/lib/db"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage } from "./message-handler"
import { fanOutToServerMembers } from "./fanout"

const InvitationInput = z.strictObject({ friend: z.string().min(1).max(128).refine((value) => Boolean(parseNameAndTag(value)), "Use a full friend handle") })

export async function inviteAutomationFriend(req: NextRequest, ctx: { env: Env; userId: string; params?: Record<string, string>; beforeCreate: () => Promise<Response | null> }) {
  const [body, error] = await parseBody(req, InvitationInput)
  if (error) return error
  const serverRef = ctx.params?.id ?? ""
  if (!parseNameAndTag(serverRef)) return writeError("Use a full server handle", 400)
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const db = getPrimaryDb(ctx.env.DB)
  const [server] = await queries.communityServer.resolveServerByNameForMember(db, ctx.userId, serverRef)
  if (!server) return writeError("Server not found", 404)
  const friend = await queries.automation.getFriendByHandle(db, ctx.userId, body.friend)
  if (!friend) return writeError("Friend not found", 404)
  const messageLimit = await checkRateLimit(ctx.env, "community:msgSend", ctx.userId)
  if (!messageLimit.allowed) return writeError("Message rate limit exceeded", 429, { "Retry-After": String(messageLimit.retryAfterSec) })
  const now = new Date().toISOString()
  const invites = await queries.communityInvite.listServerInvites(db, server.id)
  let invite = invites.find((item) => item.creatorId === ctx.userId && (!item.expiresAt || item.expiresAt > now) && (item.maxUses === null || (item.uses ?? 0) < item.maxUses))
  if (!invite) {
    const created = await queries.communityInvite.createInvite(db, { serverId: server.id, createdBy: ctx.userId, maxActive: MAX_ACTIVE_INVITES_PER_SERVER })
    if (created) {
      fanOutToServerMembers(server.id, { type: WS_EVENTS.INVITE_CREATE, serverId: server.id,
        invite: { id: created.id, token: created.token, maxUses: created.maxUses, uses: created.uses, expiresAt: created.expiresAt, createdAt: created.createdAt } })
      invite = { ...created, creatorId: ctx.userId, creatorName: null, creatorEmail: null, creatorImage: null, creatorAvatarVersion: null }
    }
  }
  if (!invite) return writeError("Server has reached its active invite limit", 409)
  const dm = await queries.communityDm.createOrGetDM(db, { userId1: ctx.userId, userId2: friend.id })
  const result = await createCommunityMessage({
    db, authorId: ctx.userId, authorKind: "human", target: { kind: "dm", channelId: dm.id, otherUserId: friend.id },
    body: { content: `${new URL(req.url).origin}/c/invite/${encodeURIComponent(invite.token)}` }, source: "web",
  })
  if (!result.ok) return writeError(result.error, result.status)
  return writeJSON({ invitation: { server: formatHandle(server.name, server.discriminator), friend: formatHandle(friend.name, friend.discriminator), sent: true } }, 201)
}
