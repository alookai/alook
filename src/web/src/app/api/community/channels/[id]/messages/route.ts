import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireChannelMember } from "@/lib/community/permissions"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { mapMessageForApi } from "@/lib/community/message-payload"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"))
  const pageSize = parsePageSize(req.nextUrl.searchParams.get("limit"))

  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)

  // All four follow-up fetches depend only on `items` / `channelId` — no
  // cross-dependency — so run them concurrently to collapse 4 sequential D1
  // round-trips into one wall-clock hop.
  const messageIds = items.map((m) => m.id)
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]

  const [allAttachments, allReactions, replyMessages, childChannels] = await Promise.all([
    messageIds.length > 0
      ? queries.communityAttachment.listByMessageIds(db, messageIds)
      : Promise.resolve([]),
    messageIds.length > 0
      ? queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
      : Promise.resolve([]),
    replyToIds.length > 0
      ? queries.communityMessage.getMessagesByIds(db, replyToIds)
      : Promise.resolve([]),
    queries.communityChannel.listChildChannels(db, channelId),
  ])

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  // Scope-check reply targets against this channel so a client can't leak
  // previews of messages from other channels/DMs just by referencing their id.
  const replyMap = new Map(
    replyMessages
      .filter((m) => m.channelId === channelId)
      .map((m) => [m.id, m]),
  )

  // Resolve threads (child channels with parentMessageId matching these messages)
  const threadByMessageId = new Map(
    childChannels
      .filter((c) => c.parentMessageId)
      .map((c) => [c.parentMessageId!, { id: c.id, name: c.name, messageCount: c.messageCount ?? 0 }] as const),
  )

  const messages = items.map((r) =>
    mapMessageForApi(r, { replyMap, attachmentsByMessage, reactionsByMessage, threadByMessageId }),
  )

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  // Thread channels (child channels with a parentChannelId) need to fire
  // CHILD_CHANNEL_UPDATE on the parent so its thread indicator ticks. Detect
  // that server-side from the channel row — clients always POST here, never
  // to a separate thread endpoint, which avoided a UI race where a fast user
  // could type before the client-side channel-meta fetch resolved.
  const target = channel.parentChannelId
    ? {
        kind: "thread" as const,
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
