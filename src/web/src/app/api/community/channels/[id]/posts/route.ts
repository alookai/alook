import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  if (channel.type !== "forum") {
    return writeError("channel is not a forum", 400)
  }

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const tag = req.nextUrl.searchParams.get("tag")

  let childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived: false,
    type: "forum_post",
  })

  if (tag) {
    childChannels = childChannels.filter((ch) => {
      if (!ch.forumTags) return false
      try {
        const tags: string[] = JSON.parse(ch.forumTags)
        return tags.includes(tag)
      } catch {
        return false
      }
    })
  }

  // Resolve author + first message for each forum post
  const posts = await Promise.all(
    childChannels.map(async (t) => {
      let authorName = "Unknown"
      let authorAvatar = "?"
      let preview = ""
      if (t.creatorId) {
        const creator = await queries.user.getUser(db, t.creatorId)
        if (creator) {
          authorName = creator.name ?? "Unknown"
          authorAvatar = creator.image ?? (creator.name ?? "?").charAt(0).toUpperCase()
        }
      }
      // Get the first message in the post as preview
      const msgs = await queries.communityMessage.listMessages(db, { channelId: t.id, limit: 1 })
      if (msgs.length > 0) {
        preview = (msgs[0].content ?? "").slice(0, 120)
      }
      let parsedTags: string[] = []
      try { parsedTags = t.forumTags ? JSON.parse(t.forumTags) : [] } catch { /* */ }
      return {
        id: t.id,
        name: t.name,
        messageCount: t.messageCount ?? 0,
        lastMessageAt: t.lastMessageAt ?? t.createdAt,
        parent: { authorName, text: preview },
        messages: [],
        authorAvatar,
        tags: parsedTags,
        preview,
      }
    })
  )

  return writeJSON({ posts })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  if (channel.type !== "forum") {
    return writeError("channel is not a forum", 400)
  }

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { name?: string; content?: string; tags?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return writeError("name is required", 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }

  // Validate tags against channel's forumTags if present
  if (body.tags && body.tags.length > 0 && channel.forumTags) {
    let allowedTags: string[]
    try {
      allowedTags = JSON.parse(channel.forumTags as string)
    } catch {
      allowedTags = []
    }
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
  const authorName = creator?.name ?? "Unknown"
  const authorAvatar = creator?.image ?? (creator?.name ?? "?").charAt(0).toUpperCase()

  fanOutToChannel(channelId, {
    type: "community:channel.child_create",
    parentChannelId: channelId,
    channel: {
      id: postChannel.id,
      name: postChannel.name,
      type: "forum_post" as const,
      creatorId: ctx.userId,
      createdAt: postChannel.createdAt,
    },
  }).catch(() => {})

  return writeJSON({
    post: {
      id: postChannel.id,
      name: postChannel.name,
      messageCount: 1,
      lastMessageAt: message.createdAt,
      parent: { authorName, text: body.content.slice(0, 120) },
      messages: [],
      authorAvatar,
      tags: body.tags ?? [],
      preview: body.content.slice(0, 120),
    },
  }, 201)
})
