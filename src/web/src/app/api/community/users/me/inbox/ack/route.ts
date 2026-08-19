import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentAckRequestSchema, type CommunityCliAckResponse } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

/**
 * POST /api/community/users/me/inbox/ack — the canonical bot batch-ack
 * (route/disc 接口树统一, ack relocation, Gener #215 乙). ack ADVANCES the bot's
 * cross-channel read waterline (`lastReadSeq`); it is the third operation on the
 * one inbox resource, completing the fetch↔advance separation (Aigneis #41):
 *   - GET  users/me/inbox/snapshot → peek (never advances)
 *   - POST users/me/inbox/pull     → fetch
 *   - POST users/me/inbox/ack      → advance
 * The waterline WRITE (bumpReadCursor) converges with the human read route's
 * markReadToMessageBuilder on the SAME communityReadState row + same 3 columns
 * (lastReadAt/lastReadMessageId/lastReadSeq) — one waterline, two input anchors
 * (bot=seq / human=messageId). That single-source is at the write layer, NOT the
 * URL: this endpoint stays a bot-native MOVE-FLAT (乙: 寻址/水位归一 ≠ URL归一),
 * kept distinct from the human PUT channels/{id}/read for three orthogonal
 * reasons — (1) batch-of-cursors best-effort + failed[] never-drop, (2) it does
 * NOT clear mentions (the human PUT does), (3) ref-resolve with create DISABLED
 * (resolve≠create). Bot-only; a human actor → 403 via requireBot (Gener #116).
 *
 * The flat /api/community/ack route is deleted (flat-delete step) — this door
 * is the sole canonical entry; the deploy-orchestration verify-list gates
 * deleting it (and inboxPull's flat verb) on the daemon being confirmed on
 * this new target.
 *
 * Best-effort per cursor, NOT fail-fast: every good cursor is applied and its
 * waterline advanced regardless of any sibling cursor failing. A single
 * unresolvable child-thread cursor must
 * never stall the healthy cursors behind it — that regressed their waterlines
 * and muted the bot in every channel with unread. Bad cursors are collected
 * into `failed[]` with a coarse `code`; the response is ALWAYS 200 (partial
 * success is not a request-level error — the good cursors DID apply, and the
 * daemon must not treat the whole call as failed). Only a genuine D1 exception
 * escaping `withD1Retry` propagates as a 500 so the daemon retries the batch.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
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
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
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
