import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentInboxPullRequestSchema } from "@alook/shared"
import { getDb, getPrimaryDb } from "@/lib/db"
import { log } from "@/lib/logger"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveMessageTarget } from "@/lib/community/message-door"

const MAX_PULL = 200

/**
 * POST /api/community/users/me/inbox/pull — the caller's own inbox pull
 * (route/disc trunk, 接口树统一 轴3; folds the flat `inboxPull` verb into the
 * users/me resource). Bot-only (human actor → 403 via requireBot); a human
 * reads unread through the inbox aggregate sub-routes, not this consuming pull.
 *
 * ⭐ users/me/* family invariant (Aigneis #426/Melly #427/#447): scope is ALWAYS
 * the caller's own userId (`gate.bot.userId` from the voucher) — this endpoint
 * takes NO target-user param, so a bot can only ever pull ITS OWN inbox, never
 * another user's unread. inbox = "my unread", so a leaked target param would be
 * a cross-user data leak; the self-scope is load-bearing here.
 *
 * Grouped-by-channel fill (v4): `ORDER BY channel_id, seq ASC`, one channel's
 * unread drained fully before the next (`seq` is per-scope). Excludes the bot's
 * own authored messages. Never mutates read state — `ack` is the only mutator.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId } = gate.bot

  // Body is optional (`InboxPullRequest = { max?, channel? }`) — an empty/missing body is
  // equivalent to `{}`, not a 400. Only a body that parses to JSON but fails
  // schema validation (e.g. `max` out of range) is rejected.
  let raw: unknown = {}
  try {
    const text = await req.text()
    if (text) raw = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentInboxPullRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const max = Math.min(parsed.data.max ?? MAX_PULL, MAX_PULL)
  // Targeted pull is the recovery sibling of the primary-backed send gate, so
  // its readState + alignment rows must come from a primary session too. A
  // replica-lagged "caught up" page would bounce immediately back to blocked
  // on the next send. Ordinary passive inbox pull stays replica-capable.
  const db = parsed.data.channel ? getPrimaryDb(ctx.env.DB) : getDb(ctx.env.DB)

  // Exact-target pull is an explicit catch-up operation, not passive inbox
  // delivery. Resolve/access-mask the ref without create-if-missing before any
  // query; a stale DM/thread ref must never materialize state as a read side
  // effect. The ordinary unscoped branch below remains notification-filtered.
  let targetedChannelId: string | undefined
  if (parsed.data.channel) {
    const resolved = await resolveMessageTarget(
      db,
      botUserId,
      { ref: parsed.data.channel },
      "bot",
    )
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.error, ...(resolved.hint ? { hint: resolved.hint } : {}) },
        { status: resolved.status },
      )
    }
    targetedChannelId = resolved.value.target.channelId
  }

  const visibleChannelIds = await withD1Retry(
    () => queries.communityAgentInbox.listAccessVisibleChannelIdsForUser(db, botUserId),
    { route: "community/users/me/inbox/pull:visibility" },
  )
  const markedCountPromise = withD1Retry(
    () => queries.communityMessageMark.countMarksForUser(
      db,
      botUserId,
      { visibleChannelIds },
    ),
    { route: "community/users/me/inbox/pull:count-marks" },
  ).catch((err: unknown) => {
    log.warn("community_inbox_marked_count_failed", {
      botUserId,
      err: err instanceof Error ? err.message : String(err),
    })
    return 0
  })
  const rowsPromise = targetedChannelId
    ? withD1Retry(async () => {
        const readState = await queries.communityReadState.getReadState(
          db,
          { userId: botUserId, channelId: targetedChannelId! },
        )
        return queries.communityAgentInbox.listAlignmentUnreadMessagesForAgentScope(
          db,
          botUserId,
          targetedChannelId!,
          { afterSeq: readState?.lastReadSeq ?? 0, max: max + 1 },
        )
      }, { route: "community/users/me/inbox/pull:list-target-unread" })
    : withD1Retry(
        () => queries.communityAgentInbox.listUnreadMessagesForAgent(
          db,
          botUserId,
          { max: max + 1, visibleChannelIds },
        ),
        { route: "community/users/me/inbox/pull:list-unread" },
      )

  const [rows, markedCount] = await Promise.all([
    rowsPromise,
    markedCountPromise,
  ])
  const hasMore = rows.length > max
  const page = hasMore ? rows.slice(0, max) : rows

  // Batch-fetch attachments in one query. Pending rows (message_id = NULL) never
  // match this inArray, so agent-uploaded pending rows are naturally excluded.
  const messageIds = page.map((r) => r.id)
  const attachmentRows = await withD1Retry(
    () => queries.communityAttachment.listByMessageIds(db, messageIds),
    { route: "community/users/me/inbox/pull:attachments" },
  )
  const attachmentsByMessageId = new Map<string, Array<{ id: string; filename: string; contentType: string | null; size: number | null }>>()
  for (const a of attachmentRows) {
    if (!a.messageId) continue
    const list = attachmentsByMessageId.get(a.messageId) ?? []
    list.push({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })
    attachmentsByMessageId.set(a.messageId, list)
  }

  const messages = await withD1Retry(
    () => queries.communityAgentInbox.toAgentMessages(
      db,
      page,
      botUserId,
      attachmentsByMessageId,
    ),
    { route: "community/users/me/inbox/pull:hydrate" },
  )
  return NextResponse.json({ messages, hasMore, markedCount })
})
