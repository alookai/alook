import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityDaemonSendAsBotRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
import { requireNotBlocked } from "@/lib/community/permissions"

/**
 * POST /api/community/daemon/bots/[botId]/messages
 *
 * Author a message AS a bot. Daemon-auth path — the daemon holds the `cmk_`
 * that identifies its machine, and the bot must be
 *   - owned by ctx.userId
 *   - bound to ctx.machineId
 *   - a member of the target channel/DM (for channel targets)
 */
export const POST = withCommunityDaemonAuth(async (req: NextRequest, ctx) => {
  const botId = ctx.params?.botId as string
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityDaemonSendAsBotRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Ownership + machine binding — same shape as enroll-agent gate.
  const target = await queries.user.getUserInternal(db, botId)
  if (
    !target ||
    target.isBot !== true ||
    target.ownerUserId !== ctx.userId ||
    target.deletedAt !== null
  ) {
    return NextResponse.json({ error: "bot not found" }, { status: 404 })
  }
  const binding = await queries.communityBot.getBotBinding(db, botId)
  if (!binding || binding.machineId !== ctx.machineId) {
    return NextResponse.json({ error: "bot not on this machine" }, { status: 404 })
  }

  const body = parsed.data

  if (body.target === "channel") {
    const channel = await queries.communityChannel.getChannel(db, body.targetId)
    if (!channel) return NextResponse.json({ error: "channel not found" }, { status: 404 })
    // Bot must be a member of the channel's server.
    const member = await queries.communityMember.getMember(db, channel.serverId, botId)
    if (!member) return NextResponse.json({ error: "bot_not_a_member" }, { status: 403 })

    const result = await createCommunityMessage({
      db,
      authorId: botId,
      target: { kind: "channel", channelId: body.targetId, serverId: channel.serverId },
      body: {
        content: body.content,
        replyToId: body.replyToId,
        mentionType: body.mentionType,
        attachments: body.attachments,
      },
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    logAudit(db, {
      serverId: channel.serverId,
      actorId: botId,
      action: COMMUNITY_AUDIT_ACTIONS.MESSAGE_AUTHORED_AS_BOT,
      targetType: "message",
      targetId: result.row.id,
      changes: JSON.stringify({
        botId,
        target: "channel",
        targetId: body.targetId,
        messageId: result.row.id,
      }),
    })
    return NextResponse.json({ messageId: result.row.id })
  }

  // dm target
  const dm = await queries.communityDm.getDM(db, body.targetId)
  if (!dm) return NextResponse.json({ error: "dm not found" }, { status: 404 })
  const inDm = dm.user1Id === botId || dm.user2Id === botId
  if (!inDm) return NextResponse.json({ error: "bot_not_a_member" }, { status: 403 })
  const otherUserId = dm.user1Id === botId ? dm.user2Id : dm.user1Id
  if (!otherUserId) return NextResponse.json({ error: "dm peer missing" }, { status: 404 })

  // Block gate — a bot must not be able to reach a peer who has blocked it
  // (or vice versa). Mirrors the user-authored DM send path.
  const notBlocked = await requireNotBlocked(db, botId, otherUserId)
  if (!notBlocked.ok) {
    return NextResponse.json({ error: notBlocked.error }, { status: notBlocked.status })
  }

  const result = await createCommunityMessage({
    db,
    authorId: botId,
    target: { kind: "dm", dmId: dm.id, otherUserId },
    body: {
      content: body.content,
      replyToId: body.replyToId,
      attachments: body.attachments,
    },
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  logAudit(db, {
    serverId: null,
    actorId: botId,
    action: COMMUNITY_AUDIT_ACTIONS.MESSAGE_AUTHORED_AS_BOT,
    targetType: "message",
    targetId: result.row.id,
    changes: JSON.stringify({
      botId,
      target: "dm",
      targetId: dm.id,
      messageId: result.row.id,
    }),
  })
  return NextResponse.json({ messageId: result.row.id })
})
