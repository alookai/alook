import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentInboxPullRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"

const MAX_PULL = 200

/**
 * POST /api/community/agent/inboxPull — plan §7.
 *
 * Grouped-by-channel fill (v4 decision): `ORDER BY channel_id, seq ASC`, one
 * channel's unread always drained fully before the next starts — `seq` is a
 * per-scope counter, so raw cross-channel seq comparison is meaningless (see
 * `listUnreadMessagesForAgent`'s doc comment). Excludes the bot's own
 * authored messages. Never mutates read state — `ack` is the only mutator
 * (debt #2 correction).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  // Body is optional (`InboxPullRequest = { max? }`) — an empty/missing body
  // is equivalent to `{}`, not a 400. Only a body that parses to JSON but
  // fails schema validation (e.g. `max` out of range) is rejected.
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

  // Fetch one extra row to detect whether more unread remain beyond `max`.
  const rows = await queries.communityAgentInbox.listUnreadMessagesForAgent(db, ctx.botUserId, { max: max + 1 })
  const hasMore = rows.length > max
  const page = hasMore ? rows.slice(0, max) : rows

  const messages = await queries.communityAgentInbox.toAgentMessages(db, page, ctx.botUserId)
  return NextResponse.json({ messages, hasMore })
})
