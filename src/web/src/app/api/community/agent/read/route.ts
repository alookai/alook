import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentReadRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"

/**
 * POST /api/community/agent/read — plan §7. Seq-anchored pagination (NOT
 * `createdAt`-based) — pick at most one of `before`/`after`/`around`
 * (enforced at the Zod layer). Response is `{ items, hasMore, latestSeq? }`
 * — `items`, not `messages` (that name is reserved for `inboxPull`'s shape).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
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

  const resolved = await resolveTargetForMember(db, ctx.botUserId, body.channel, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  const scopeTarget =
    resolved.kind === "dm" ? { dmConversationId: resolved.dmConversationId } : { channelId: resolved.channelId }

  if (resolved.kind === "dm") {
    const gate = await requireDMParticipant(db, resolved.dmConversationId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const { items, hasMore, latestSeq } = await queries.communityAgentInbox.listMessagesBySeq(db, scopeTarget, {
    before: body.before,
    after: body.after,
    around: body.around,
    limit: body.limit,
  })
  const messages = await queries.communityAgentInbox.toAgentMessages(db, items, ctx.botUserId)

  return NextResponse.json({ items: messages, hasMore, ...(latestSeq !== undefined ? { latestSeq } : {}) })
})
