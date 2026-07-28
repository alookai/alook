import { NextResponse, type NextRequest } from "next/server"
import {
  queries,
  CommunityAgentReactAddRequestSchema,
  MAX_EMOJI_BYTES,
  WS_EVENTS,
  isUniqueConstraintError,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import { fanOutToChannel, fanOutToDM } from "@/lib/community/fanout"

/**
 * POST /api/community/agent/reactAdd — agent-facing counterpart of the user
 * route's PUT /api/community/messages/[id]/reactions/[emoji]. Body
 * `{ channel, seq, emoji }`; identity is the bearer voucher (never a
 * client-supplied agentId). Duplicates are idempotent: the DB unique
 * constraint on `(messageId, userId, emoji)` throws, `isUniqueConstraintError`
 * catches it, and the endpoint returns `{ ok:true, duplicate:true }` without
 * a fan-out.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentReactAddRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  if (Buffer.byteLength(body.emoji, "utf8") > MAX_EMOJI_BYTES) {
    return NextResponse.json({ error: "emoji too long" }, { status: 400 })
  }

  const resolved = await resolveTargetForMember(db, ctx.botUserId, body.channel, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  const scopeTarget = { channelId: resolved.channelId }

  if (isDmTarget(resolved)) {
    const gate = await requireDMAccess(db, resolved.channelId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const row = await queries.communityMessage.getMessageByChannelAndSeq(db, scopeTarget, body.seq)
  if (!row) {
    return NextResponse.json({ error: `no message with seq #${body.seq} in ${body.channel}` }, { status: 404 })
  }

  try {
    await queries.communityReaction.addReaction(db, {
      messageId: row.id,
      userId: ctx.botUserId,
      emoji: body.emoji,
    })
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return NextResponse.json({ ok: true, duplicate: true })
    }
    throw e
  }

  const event = {
    type: WS_EVENTS.REACTION_ADD as typeof WS_EVENTS.REACTION_ADD,
    messageId: row.id,
    userId: ctx.botUserId,
    emoji: body.emoji,
    channelId: resolved.channelId,
  }

  if (isDmTarget(resolved)) {
    await fanOutToDM(resolved.channelId, event, { excludeUserId: ctx.botUserId })
  } else {
    await fanOutToChannel(resolved.channelId, event, { excludeUserId: ctx.botUserId })
  }

  return NextResponse.json({ ok: true })
})
