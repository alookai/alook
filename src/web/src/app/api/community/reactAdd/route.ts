import { NextResponse, type NextRequest } from "next/server"
import {
  queries,
  withD1Retry,
  CommunityAgentReactAddRequestSchema,
  MAX_EMOJI_BYTES,
  WS_EVENTS,
  isUniqueConstraintError,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveTargetById, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import { requireReactableSurface } from "@/lib/community/channel-write-guard"
import { fanOutToChannel, fanOutToDM } from "@/lib/community/fanout"

/**
 * POST /api/community/reactAdd — agent-facing counterpart of the user
 * route's PUT /api/community/messages/[id]/reactions/[emoji]. Body
 * `{ channel, seq, emoji }`; identity is the bearer voucher (never a
 * client-supplied agentId). Duplicates are idempotent: the DB unique
 * constraint on `(messageId, userId, emoji)` throws, `isUniqueConstraintError`
 * catches it, and the endpoint returns `{ ok:true, duplicate:true }` without
 * a fan-out.
 * Moved from /agent (plan §4 MOVE-FLAT, §9 phase 3); bot-only, human actor → 403 via requireBot.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const botUserId = gate.bot.userId
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

  const resolved = body.channelId !== undefined
    ? await resolveTargetById(db, botUserId, body.channelId)
    : await resolveTargetForMember(db, botUserId, body.channel!, {
        createDmIfMissing: false,
        createThreadIfMissing: false,
        callerKind: "bot",
      })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  const scopeTarget = { channelId: resolved.channelId }

  if (isDmTarget(resolved)) {
    const gate = await requireDMAccess(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    const reactable = requireReactableSurface("dm")
    if (!reactable.ok) return NextResponse.json({ error: reactable.error }, { status: reactable.status })
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    const reactable = requireReactableSurface(gate.value.type)
    if (!reactable.ok) return NextResponse.json({ error: reactable.error }, { status: reactable.status })
  }

  const row = await queries.communityMessage.getMessageByChannelAndSeq(db, scopeTarget, body.seq)
  if (!row) {
    return NextResponse.json({ error: `no message with seq #${body.seq} in ${body.channel}` }, { status: 404 })
  }

  try {
    // `withD1Retry` (D1-armor state 3, idempotent write): unique per
    // (messageId, userId, emoji), so a retry can't double-add. Transient
    // retries; the UNIQUE-constraint error isn't in the whitelist so withD1Retry
    // rethrows it straight into the catch (dup → { ok: true, duplicate: true }).
    await withD1Retry(
      () =>
        queries.communityReaction.addReaction(db, {
          messageId: row.id,
          userId: botUserId,
          emoji: body.emoji,
        }),
      { route: "reactAdd" },
    )
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return NextResponse.json({ ok: true, duplicate: true })
    }
    throw e
  }

  const event = {
    type: WS_EVENTS.REACTION_ADD as typeof WS_EVENTS.REACTION_ADD,
    messageId: row.id,
    userId: botUserId,
    emoji: body.emoji,
    channelId: resolved.channelId,
  }

  if (isDmTarget(resolved)) {
    await fanOutToDM(resolved.channelId, event, { excludeUserId: botUserId })
  } else {
    await fanOutToChannel(resolved.channelId, event, { excludeUserId: botUserId })
  }

  return NextResponse.json({ ok: true })
})
