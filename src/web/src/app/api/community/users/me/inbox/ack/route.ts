import { withAuth } from "@/lib/middleware/auth-policy"
import { flattenError } from "zod"
import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentAckRequestSchema, type CommunityCliAckResponse } from "@alook/shared"
import { getDb } from "@/lib/db"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

/**
 * Bot ack shares the human read-state row, but uses sequence anchors and does
 * not clear mentions or create targets. Apply valid cursors despite sibling
 * failures, returning failed[] with HTTP200. Unhandled D1 errors remain500
 * so the daemon can retry the batch.
 */
export const POST = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId } = gate.bot

  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentAckRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: flattenError(parsed.error) }, { status: 400 })
  }

  const applied: Array<{ channel: string; seq: number }> = []
  const failed: Array<{ channel: string; seq: number; code: "unresolvable" | "forbidden" | "no_such_seq"; error: string }> = []

  for (const cursor of parsed.data.cursors) {
    const resolved = await resolveTargetForMember(db, botUserId, cursor.channel, {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    if ("error" in resolved) {
      failed.push({ channel: cursor.channel, seq: cursor.seq, code: "unresolvable", error: resolved.message })
      continue
    }

    const scopeTarget = { channelId: resolved.channelId }

    if (isDmTarget(resolved)) {
      const gate = await requireDMAccess(db, resolved.channelId, botUserId)
      if (!gate.ok) {
        failed.push({ channel: cursor.channel, seq: cursor.seq, code: "forbidden", error: gate.error })
        continue
      }
    } else {
      const gate = await requireChannelMember(db, resolved.channelId, botUserId)
      if (!gate.ok) {
        failed.push({ channel: cursor.channel, seq: cursor.seq, code: "forbidden", error: gate.error })
        continue
      }
    }

    // Idempotent write — safe to retry a transient D1 blip (same treatment as
    // the human-facing routes). A real "no such seq" is a structured `null`
    // return below, not a thrown error, so it is never retried. A genuine D1
    // exception escaping withD1Retry is NOT caught here — it propagates as a
    // 500 so the daemon retries the whole batch (never swallow infra failures
    // into `failed`).
    const bumped = await withD1Retry(
      () => queries.communityReadState.bumpReadCursor(db, botUserId, scopeTarget, cursor.seq),
      { route: "community/users/me/inbox/ack:bump" },
    )
    if (!bumped) {
      failed.push({
        channel: cursor.channel,
        seq: cursor.seq,
        code: "no_such_seq",
        error: `no message with seq #${cursor.seq} in ${cursor.channel}`,
      })
      continue
    }
    applied.push({ channel: cursor.channel, seq: cursor.seq })
  }

  const response: CommunityCliAckResponse = { ok: failed.length === 0, applied, failed }
  return NextResponse.json(response)
})
