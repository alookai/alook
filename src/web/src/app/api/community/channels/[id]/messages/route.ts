import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isPost } from "@alook/shared"
import {
  parseCursor,
  parseAnchor,
  parsePageSize,
  buildPaginatedResponse,
  buildAnchorResponse,
  buildSinceResponse,
} from "@/lib/community/messages"
import { enrichMessages } from "@/lib/community/enrich-messages"
import { requireChannelMember } from "@/lib/community/permissions"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage } from "@/lib/community/message-handler"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const params = req.nextUrl.searchParams
  const anchorId = parseAnchor(params.get("anchor"))
  const since = parseCursor(params.get("since"))
  const cursor = parseCursor(params.get("cursor"))
  const pageSize = parsePageSize(params.get("limit"))

  // Seq-addressed pagination: `aroundSeq`/`afterSeq`/`beforeSeq` locate a
  // message by its per-channel sequence number, then delegate to the same
  // createdAt-windowed queries the anchor/since/cursor branches use — seq and
  // createdAt are assigned in one insert, so they sort identically within a
  // scope. This lets a caller page by seq without a separate query family;
  // the createdAt-cursor branches below are unchanged. At most one seq param
  // is honored (around > after > before).
  const seqParam = (name: string): number | undefined => {
    const v = params.get(name)
    if (!v) return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const aroundSeq = seqParam("aroundSeq")
  const afterSeq = seqParam("afterSeq")
  const beforeSeq = seqParam("beforeSeq")

  if (aroundSeq !== undefined || afterSeq !== undefined || beforeSeq !== undefined) {
    const targetSeq = aroundSeq ?? afterSeq ?? beforeSeq!
    const at = await queries.communityMessage.getMessageByChannelAndSeq(db, { channelId }, targetSeq)
    if (!at) return writeError("message not found", 404)
    const anchor = { createdAt: at.createdAt, id: at.id }

    if (aroundSeq !== undefined) {
      const around = await queries.communityMessage.listMessagesAround(db, { channelId, anchor, limit: pageSize })
      const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
        around.older,
        around.newer,
        { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
      )
      const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
      return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
    }
    if (afterSeq !== undefined) {
      const rows = await queries.communityMessage.listMessagesSince(db, { channelId, since: anchor, limit: pageSize })
      const { items, hasMoreNewer, newerCursor } = buildSinceResponse(rows, pageSize)
      const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
      return writeJSON({ messages, hasMoreNewer, newerCursor, latestSeq })
    }
    // beforeSeq: strictly-older page, delegating to the cursor query.
    const rows = await queries.communityMessage.listMessages(db, { channelId, cursor: anchor, limit: pageSize + 1 })
    const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items.slice().reverse())
    return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
  }

  // Anchor branch: resolve the target message inside the channel scope first
  // (a scope-first lookup — see AGENTS.md "scope the queries before"), then
  // fetch the centered window and enrich.
  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { channelId })
    if (!anchor) return writeError("anchor not found", 404)

    const around = await queries.communityMessage.listMessagesAround(db, {
      channelId,
      anchor: { createdAt: anchor.createdAt, id: anchor.id },
      limit: pageSize,
    })

    const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
      around.older,
      around.newer,
      { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
    )

    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
    return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
  }

  // Since branch: strictly-newer diff for cache hydration & WS-reconnect
  // catch-up. Rows arrive ASC directly from the query; no reverse pass here.
  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, {
      channelId,
      since,
      limit: pageSize,
    })
    const { items, hasMoreNewer, newerCursor } = buildSinceResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
    return writeJSON({ messages, hasMoreNewer, newerCursor, latestSeq })
  }

  // Legacy branch (unchanged behavior beyond `latestSeq` addition): newest page
  // via DESC + one-extra-row probe, response items reversed to ASC.
  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items.slice().reverse())
  return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  const rateLimit = await checkRateLimit(ctx.env, "community:msgSend", ctx.userId)
  if (!rateLimit.allowed) {
    return writeError("rate limited", 429, { "Retry-After": String(rateLimit.retryAfterSec) })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  // Child channels (those with a parentChannelId — threads AND posts) fire
  // CHILD_CHANNEL_UPDATE on the parent so its indicator ticks, and both scope
  // their notify set to participants. They're distinguished by `channel.type`:
  // a post uses the `post` target kind so it can't silently ride the thread
  // branch. Detected server-side from the channel row — clients always POST
  // here, never to a separate endpoint, which avoided a UI race where a fast
  // user could type before a client-side meta fetch resolved.
  const target = channel.parentChannelId
    ? {
        kind: isPost(channel.type) ? ("post" as const) : ("thread" as const),
        channelId,
        parentChannelId: channel.parentChannelId,
        serverId: channel.serverId,
      }
    : {
        kind: "channel" as const,
        channelId,
        serverId: channel.serverId,
      }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target,
    body: body as Record<string, unknown>,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ message: result.row }, 201)
})
