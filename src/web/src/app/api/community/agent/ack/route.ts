import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentAckRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

/**
 * POST /api/community/agent/ack — plan §7. The ONLY endpoint that advances
 * `lastReadSeq` (`inboxPull` never mutates read state — debt #2 correction).
 * Each cursor's `channel` ref is resolved read-only (no DM/thread
 * auto-create — a stale ref must never materialize a row as a side effect
 * of an ack) and membership-gated before `bumpReadCursor`.
 *
 * Best-effort per cursor, NOT fail-fast: every good cursor is applied and its
 * waterline advanced regardless of any sibling cursor failing. A single
 * unresolvable cursor (e.g. a forum_post whose ref can't parse back) must
 * never stall the healthy cursors behind it — that regressed their waterlines
 * and muted the bot in every channel with unread. Bad cursors are collected
 * into `failed[]` with a coarse `code`; the response is ALWAYS 200 (partial
 * success is not a request-level error — the good cursors DID apply, and the
 * daemon must not treat the whole call as failed). Only a genuine D1 exception
 * escaping `withD1Retry` propagates as a 500 so the daemon retries the batch.
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

  const applied: Array<{ channel: string; seq: number }> = []
  const failed: Array<{ channel: string; seq: number; code: "unresolvable" | "forbidden" | "no_such_seq"; error: string }> = []

  for (const cursor of parsed.data.cursors) {
    const resolved = await resolveTargetForMember(db, ctx.botUserId, cursor.channel, {
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
      const gate = await requireDMAccess(db, resolved.channelId, ctx.botUserId)
      if (!gate.ok) {
        failed.push({ channel: cursor.channel, seq: cursor.seq, code: "forbidden", error: gate.error })
        continue
      }
    } else {
      const gate = await requireChannelMember(db, resolved.channelId, ctx.botUserId)
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
      () => queries.communityReadState.bumpReadCursor(db, ctx.botUserId, scopeTarget, cursor.seq),
      { route: "community/agent/ack:bump" },
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

  return NextResponse.json({ ok: failed.length === 0, applied, failed })
})
