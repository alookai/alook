import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentAckRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"

/**
 * POST /api/community/agent/ack — plan §7. The ONLY endpoint that advances
 * `lastReadSeq` (`inboxPull` never mutates read state — debt #2 correction).
 * Each cursor's `channel` ref is resolved read-only (no DM/thread
 * auto-create — a stale ref must never materialize a row as a side effect
 * of an ack) and membership-gated before `bumpReadCursor`. Fails fast on
 * the first bad cursor; earlier cursors in the same request have already
 * been durably applied (`bumpReadCursor` is independently atomic per call).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentAckRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }

  for (const cursor of parsed.data.cursors) {
    const resolved = await resolveTargetForMember(db, ctx.botUserId, cursor.channel, {
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

    const bumped = await queries.communityReadState.bumpReadCursor(db, ctx.botUserId, scopeTarget, cursor.seq)
    if (!bumped) {
      return NextResponse.json(
        { error: `no message with seq #${cursor.seq} in ${cursor.channel}` },
        { status: 404 }
      )
    }
  }

  return NextResponse.json({ ok: true })
})
