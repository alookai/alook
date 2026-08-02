import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentResolveRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

/**
 * POST /api/community/resolve — moved from /api/community/agent/resolve
 * (plan §4 MOVE-FLAT, §9 phase 3). Body `{ channel, seq }` — a REF + seq (kept,
 * not id-addressed: Gener #68). Ref-in-body is why this can't fold onto the
 * `[id]`-parameterized human message routes (Fork B): the bot holds a ref, the
 * CLI has no DB to resolve it into a channelId, so `resolveTargetForMember`
 * must run server-side.
 *
 * Bot-only verb: a human actor is rejected 403 (`requireBot`, Gener #116). The
 * handler body is unchanged from the /agent original — only the wrapper
 * (withAgentRunnerAuth → withCommunityActor) and the identity source
 * (ctx.botUserId → ctx.actor.userId) differ. `seq === 0` is the legacy
 * pre-migration sentinel, rejected 404.
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
  const parsed = CommunityAgentResolveRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  if (body.seq === 0) {
    return NextResponse.json({ error: "seq 0 is not a real message" }, { status: 404 })
  }

  const resolved = await resolveTargetForMember(db, botUserId, body.channel, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  const scopeTarget = { channelId: resolved.channelId }

  if (isDmTarget(resolved)) {
    const gate = await requireDMAccess(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  // `withD1Retry` (D1-armor: no-fallback agent RPC read; retry to truth). Drives 404.
  const row = await withD1Retry(
    () => queries.communityMessage.getMessageByChannelAndSeq(db, scopeTarget, body.seq),
    { route: "resolve/message" },
  )
  if (!row) {
    return NextResponse.json({ error: `no message with seq #${body.seq} in ${body.channel}` }, { status: 404 })
  }

  // Attachments + agent-message shaping, retried as one unit (both reads).
  const message = await withD1Retry(
    async () => {
      const attachmentRows = await queries.communityAttachment.listByMessageIds(db, [row.id])
      const attachments = attachmentRows.map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      }))
      return queries.communityAgentInbox.toAgentMessage(db, row, botUserId, attachments)
    },
    { route: "resolve" },
  )
  return NextResponse.json({ message })
})
