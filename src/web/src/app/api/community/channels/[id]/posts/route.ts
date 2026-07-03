import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_PREVIEW_LENGTH,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { requireChannelMember } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  if (channel.type !== "forum") {
    return writeError("channel is not a forum", 400)
  }

  const tag = req.nextUrl.searchParams.get("tag")

  let childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived: false,
    type: "forum_post",
  })

  if (tag) {
    childChannels = childChannels.filter((ch) => ch.tags.includes(tag))
  }

  // Batch-fetch all creators in one query
  const creatorIds = [...new Set(childChannels.map((t) => t.creatorId).filter(Boolean) as string[])]
  const creators = creatorIds.length > 0 ? await queries.user.getUsersByIds(db, creatorIds) : []
  const creatorMap = new Map(creators.map((u) => [u.id, u]))

  // Batch-fetch first message for each post channel
  const postChannelIds = childChannels.map((t) => t.id)
  const firstMessages = postChannelIds.length > 0
    ? await queries.communityMessage.getFirstMessageByChannelIds(db, postChannelIds)
    : []
  const previewMap = new Map(firstMessages.map((m) => [m.channelId, m.content]))

  const posts = childChannels.map((t) => {
    const creator = t.creatorId ? creatorMap.get(t.creatorId) : null
    // creator can be null if the user was deleted (channel.creatorId has ON DELETE SET NULL).
    const authorName = creator ? creator.name : ""
    const authorAvatar = creator?.image ?? avatarInitial(authorName)
    const preview = (previewMap.get(t.id) ?? "").slice(0, MESSAGE_PREVIEW_LENGTH)
    return {
      id: t.id,
      name: t.name,
      messageCount: t.messageCount ?? 0,
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      parent: { authorName, text: preview },
      authorAvatar,
      tags: t.tags ?? [],
      preview,
    }
  })

  return writeJSON({ posts })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  if (channel.type !== "forum") {
    return writeError("channel is not a forum", 400)
  }

  let body: { name?: string; content?: string; tags?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return writeError("name is required", 400)
  }
  if (body.name.trim().length > MAX_CHANNEL_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }
  if (body.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return writeError(`content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  }

  // Validate tags against channel's tags if present
  if (body.tags && body.tags.length > 0) {
    const allowedTags = channel.tags ?? []
    if (allowedTags.length > 0) {
      const invalid = body.tags.filter((t) => !allowedTags.includes(t))
      if (invalid.length > 0) {
        return writeError(`invalid tags: ${invalid.join(", ")}`, 400)
      }
    }
  }

  // Create child channel for the forum post
  const postChannel = await queries.communityChannel.createChannel(db, {
    serverId: channel.serverId,
    parentChannelId: channelId,
    name: body.name.trim(),
    type: "forum_post",
    creatorId: ctx.userId,
  })

  // Set forumTags on the post channel to store selected tags
  if (body.tags?.length) {
    await queries.communityChannel.updateChannel(db, postChannel.id, {
      forumTags: JSON.stringify(body.tags),
    })
  }

  // Create the first message in the post
  const message = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    channelId: postChannel.id,
  })

  // Resolve author info for response
  const creator = await queries.user.getUser(db, ctx.userId)
  const authorName = creator ? creator.name : ""
  const authorAvatar = creator?.image ?? avatarInitial(authorName)

  fanOutToChannel(channelId, {
    type: WS_EVENTS.CHILD_CHANNEL_CREATE,
    parentChannelId: channelId,
    channel: {
      id: postChannel.id,
      name: postChannel.name,
      type: "forum_post" as const,
      creatorId: ctx.userId,
      createdAt: postChannel.createdAt,
    },
  })

  return writeJSON({
    post: {
      id: postChannel.id,
      name: postChannel.name,
      messageCount: 1,
      lastMessageAt: message.createdAt,
      parent: { authorName, text: body.content.slice(0, MESSAGE_PREVIEW_LENGTH) },
      authorAvatar,
      tags: body.tags ?? [],
      preview: body.content.slice(0, MESSAGE_PREVIEW_LENGTH),
    },
  }, 201)
})
