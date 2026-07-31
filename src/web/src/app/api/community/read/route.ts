import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentReadRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveTargetById, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

/**
 * POST /api/community/read — plan §7. Seq-anchored pagination (NOT
 * `createdAt`-based) — pick at most one of `before`/`after`/`around`
 * (enforced at the Zod layer). Response is `{ items, hasMore, latestSeq? }`
 * — `items`, not `messages` (that name is reserved for `inboxPull`'s shape).
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
  const parsed = CommunityAgentReadRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

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
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const { items, hasMore, latestSeq } = await queries.communityAgentInbox.listMessagesBySeq(db, scopeTarget, {
    before: body.before,
    after: body.after,
    around: body.around,
    limit: body.limit,
  })
  const messages = await queries.communityAgentInbox.toAgentMessages(db, items, botUserId)

  return NextResponse.json({ items: messages, hasMore, ...(latestSeq !== undefined ? { latestSeq } : {}) })
})
