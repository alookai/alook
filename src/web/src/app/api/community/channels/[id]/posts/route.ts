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

  let threads = await queries.communityThread.listChannelThreads(db, channelId, {
    archived: false,
  })

  if (tag) {
    threads = threads.filter((thread) => {
      if (!thread.tags) return false
      try {
        const tags: string[] = JSON.parse(thread.tags)
        return tags.includes(tag)
      } catch {
        return false
      }
    })
  }

  return writeJSON(threads)
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

  const thread = await queries.communityThread.createThread(db, {
    channelId,
    name: body.name.trim(),
    kind: "forum_post",
    tags: body.tags ? JSON.stringify(body.tags) : undefined,
    creatorId: ctx.userId,
  })

  const message = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    threadId: thread.id,
  })

  fanOutToChannel(channelId, {
    type: "community:thread.create",
    channelId,
    thread: {
      id: thread.id,
      name: thread.name,
      kind: thread.kind as "thread" | "forum_post",
      creatorId: thread.creatorId ?? undefined,
      createdAt: thread.createdAt,
    },
  }).catch(() => {})

  return writeJSON({ thread, message }, 201)
})
