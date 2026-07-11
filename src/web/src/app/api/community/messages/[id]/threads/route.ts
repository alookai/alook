import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_CHANNEL_NAME_LENGTH, WS_EVENTS } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { requireChannelMember } from "@/lib/community/permissions"
import { mapMessageForWs } from "@/lib/community/message-payload"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)
  if (!message.channelId) return writeError("message is not in a channel", 400)

  const auth = await requireChannelMember(db, message.channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  if (!body.name || typeof body.name !== "string") return writeError("name is required", 400)
  const name = body.name.trim()
  if (!name || name.length > MAX_CHANNEL_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
  }

  // One thread per message.
  const existing = await queries.communityChannel.listChildChannels(db, message.channelId, {
    type: "thread",
  })
  if (existing.some((c) => c.parentMessageId === messageId)) {
    return writeError("message already has a thread", 409)
  }

  const childChannel = await queries.communityChannel.createChannel(db, {
    serverId: channel.serverId,
    parentChannelId: message.channelId,
    parentMessageId: messageId,
    name,
    type: "thread",
    creatorId: ctx.userId,
  })

  // Note: we intentionally do NOT clone the parent message into the new thread
  // channel. The `parentMessageId` pointer above is the single source of truth
  // for the opener — the thread page fetches the parent live via
  // GET /api/community/messages/[id] and renders it as a pinned block at the
  // top of the message list. Cloning would drift the moment the original is
  // edited, and it never carried attachments / reactions / mentions in the
  // first place.

  fanOutToChannel(message.channelId, {
    type: WS_EVENTS.CHILD_CHANNEL_CREATE,
    parentChannelId: message.channelId,
    channel: {
      id: childChannel.id,
      name: childChannel.name,
      type: "thread" as const,
      creatorId: ctx.userId,
      createdAt: childChannel.createdAt,
    },
    parentMessageId: messageId,
  }, { excludeUserId: ctx.userId })

  // Insert a real system-message row into the PARENT channel (always
  // `MessageList`-rendered, unlike the forum-post case — see the debt
  // record's Out of scope note on why `POST .../posts` doesn't get this
  // same treatment) so the "a thread was created" notice persists and
  // reaches every viewer via the same `community:message.create` broadcast
  // regular sends use — no new WS handler needed on the client (see
  // `use-community-ws.ts`'s existing `insertMessageIntoCache`).
  //
  // `type: "thread_created"` was already documented as a possible
  // `communityMessage.type` value (see `message-payload.ts`) but never
  // actually written anywhere until now.
  const creator = await queries.user.getUserInternal(db, ctx.userId)
  const systemMessage = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: `${creator?.name ?? "Someone"} started a thread: ${name}`,
    channelId: message.channelId,
    type: "thread_created",
  })
  const systemRow = await queries.communityMessage.getMessage(db, systemMessage.id)
  if (systemRow) {
    // No `excludeUserId` here — unlike most sends, the thread creator did
    // not author this system message client-side (no optimistic row), so
    // they need the WS broadcast too to see it without a refresh.
    // `insertMessageIntoCache` dedupes by id, so this is safe even if a
    // future change adds an optimistic row for the creator.
    fanOutToChannel(message.channelId, {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: message.channelId,
      message: mapMessageForWs(systemRow, { replyMap: new Map(), attachments: [] }),
    })
  }

  return writeJSON(childChannel, 201)
})
