import { withAuth } from "@/lib/middleware/auth-policy"
import { flattenError } from "zod"
import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentInboxPullRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { log } from "@/lib/logger"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"

const MAX_PULL = 200

/**
 * Bot-only, self-scoped unread fetch. Neither fetch endpoint advances read
 * state; ack owns that write. The CLI combines pull and ack separately.
 */
export const POST = withAuth(communityActorPolicy({ allowInactiveBot: true }), async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId, isActive } = gate.bot

  // Inactive bots have no inbox surface at all. Gate before visibility,
  // unread, mark, attachment, or hydration work so an inactive daemon cannot
  // observe or consume backlog through the REST door. Runner auth already read
  // this binding flag, so the polling hot path does not pay a duplicate D1 read.
  if (!isActive) {
    return NextResponse.json({ messages: [], hasMore: false, markedCount: 0 })
  }

  const db = getDb(ctx.env.DB)

  // Body is optional (`InboxPullRequest = { max? }`) — an empty/missing body is
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
    return NextResponse.json({ error: "invalid payload", details: flattenError(parsed.error) }, { status: 400 })
  }
  const max = Math.min(parsed.data.max ?? MAX_PULL, MAX_PULL)

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
  const [rows, markedCount] = await Promise.all([
    withD1Retry(
      () => queries.communityAgentInbox.listUnreadMessagesForAgent(
        db,
        botUserId,
        { max: max + 1, visibleChannelIds },
      ),
      { route: "community/users/me/inbox/pull:list-unread" },
    ),
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
