import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentResolveRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"

/**
 * POST /api/community/agent/resolve — plan §7. Body `{ channel, seq }` (two
 * separate fields, not a combined `"/server/channel#N"` ref string — the
 * CLI's own `parseRef` already splits a user-typed ref before calling this).
 * `seq === 0` is the legacy pre-migration sentinel, never a real message —
 * rejected with 404 (defense-in-depth).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
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

  const row = await queries.communityMessage.getMessageByChannelAndSeq(db, scopeTarget, body.seq)
  if (!row) {
    return NextResponse.json({ error: `no message with seq #${body.seq} in ${body.channel}` }, { status: 404 })
  }

  const message = await queries.communityAgentInbox.toAgentMessage(db, row, ctx.botUserId)
  return NextResponse.json({ message })
})
