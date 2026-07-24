import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_CHANNEL_NAME_LENGTH, WS_EVENTS } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { requireChannelMember } from "@/lib/community/permissions"

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

  // Threads may only root on a TOP-LEVEL channel's message. Rooting on a child
  // channel (a forum post, or another thread) would make the new thread a
  // grandchild whose privacy the single-level anchor climb can't resolve — it
  // would read the child's own `categoryId` (always NULL) as public and leak a
  // private forum's thread server-wide. The UI already forbids this (child
  // views pass no create-thread action); enforce it on the API too.
  if (channel.parentChannelId) {
    return writeError("can't start a thread on a message in a thread or forum post", 400)
  }

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

  // Seed the default NOTIFY set: the thread creator (source "spoke", matching
  // the forum-post creation flow and what the message-handler would write once
  // they post), plus the original message's author (source "added" — they were
  // pulled in by someone else, like the manual add-participant flow). The
  // author is only enrolled if they are STILL a member of the parent channel —
  // `requireChannelMember` above only gated the creator, so seeding the author
  // unconditionally could push a private channel's thread to someone who lost
  // access (the leak `removeParticipantFromChildChannels` exists to prevent).
  const seedRows: { userId: string; source: "spoke" | "added" }[] = [
    { userId: ctx.userId, source: "spoke" },
  ]
  // De-dupe: when the creator threads their own message the author is the same
  // user, and the creator's "spoke" row already covers them.
  if (message.authorId !== ctx.userId) {
    const authorStillMember = await requireChannelMember(db, message.channelId, message.authorId)
    if (authorStillMember.ok) seedRows.push({ userId: message.authorId, source: "added" })
  }
  await queries.communityThread.addThreadParticipants(db, childChannel.id, seedRows)

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

  return writeJSON(childChannel, 201)
})
