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
  slugify,
} from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { requireChannelMember, requireChannelAccess } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"
import { createCommunityMessage } from "@/lib/community/message-handler"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelAccess(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value.channel

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

  // Unified model: a forum's posts INHERIT the forum's access (a post is not its
  // own access unit — like a thread inherits its channel). Reaching here means
  // `requireChannelAccess` already granted the viewer access to the forum (a
  // private forum 403s a non-member up front), so they see ALL of its posts. No
  // per-post membership filter.

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

  // Batch-fetch each post's participant (notify) set for the card AvatarGroup.
  // A post's participants are the people actually involved (creator + whoever
  // spoke / was mentioned / was added), the same set fan-out notifies. Grouped
  // by channel id and ordered by `addedAt` so the creator (earliest "spoke"
  // row) leads.
  const participantRows = postChannelIds.length > 0
    ? await queries.communityThread.listParticipantsForChannels(db, postChannelIds)
    : []
  const participantsByPost = new Map<string, { id: string; name: string; avatar: string }[]>()
  for (const r of [...participantRows].sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    const list = participantsByPost.get(r.channelId) ?? []
    list.push({ id: r.userId, name: r.userName ?? "", avatar: r.userImage ?? avatarInitial(r.userName ?? "") })
    participantsByPost.set(r.channelId, list)
  }

  const posts = childChannels.map((t) => {
    const creator = t.creatorId ? creatorMap.get(t.creatorId) : null
    // creator can be null if the user was deleted (channel.creatorId has ON DELETE SET NULL).
    const authorName = creator ? creator.name : ""
    const authorAvatar = creator?.image ?? avatarInitial(authorName)
    const preview = (previewMap.get(t.id) ?? "").slice(0, MESSAGE_PREVIEW_LENGTH)
    return {
      id: t.id,
      name: t.name,
      // Excludes the body message — the body IS the first message; the badge
      // shows reply count, not total message count.
      messageCount: Math.max(0, (t.messageCount ?? 0) - 1),
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      parent: { authorName, text: preview },
      authorId: t.creatorId ?? "",
      authorAvatar,
      tags: t.tags ?? [],
      preview,
      participants: participantsByPost.get(t.id) ?? [],
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

  let body: { name?: string; content?: string; attachments?: unknown; mentionType?: unknown }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return writeError("name is required", 400)
  }
  const trimmedName = body.name.trim()
  if (trimmedName.length > MAX_CHANNEL_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
  }
  const name = slugify(trimmedName)
  if (!name) {
    return writeError("name is required", 400)
  }

  const content = typeof body.content === "string" ? body.content : ""
  const hasContent = content.trim().length > 0
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0
  if (!hasContent && !hasAttachments) {
    return writeError("post is empty", 400)
  }
  if (hasContent && content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return writeError(`content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  }

  // Create child channel for the forum post. Tags are NOT set at creation —
  // they're added afterward from the post card's tag dialog.
  const postChannel = await queries.communityChannel.createChannel(db, {
    serverId: channel.serverId,
    parentChannelId: channelId,
    name,
    type: "forum_post",
    creatorId: ctx.userId,
  })

  // Enroll the creator as a participant so the post's notify set (which fan-out
  // now scopes to for a forum_post, exactly like a thread) starts with its
  // author. Done via a direct addThreadParticipants call rather than by routing
  // the first message as `kind:"forum_post"` — that would fire a
  // CHILD_CHANNEL_UPDATE colliding with the CHILD_CHANNEL_CREATE emitted below.
  await queries.communityThread.addThreadParticipants(db, postChannel.id, [
    { userId: ctx.userId, source: "spoke" },
  ])

  // Create the first message in the post through the unified pipeline so it
  // gets mention extraction + private-channel audience scoping (the forum's
  // privacy climbs the parent via `isChannelPrivate`) — the direct
  // `createMessage` insert this replaced dropped mentions (plan gap #2). Route
  // as `kind:"channel"` with the post's OWN channelId (NOT `kind:"thread"` —
  // that fires a CHILD_CHANNEL_UPDATE colliding with the CHILD_CHANNEL_CREATE
  // this route already emits below). The emitted MESSAGE_CREATE is deduped by
  // id on the client against that CHILD_CHANNEL_CREATE.
  const created = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: { kind: "channel", channelId: postChannel.id, serverId: channel.serverId },
    body: { content, attachments: body.attachments, mentionType: body.mentionType },
  })
  if (!created.ok) return writeError(created.error, created.status)
  const message = created.row

  // Resolve author info for response
  const creator = await queries.user.getUserSelf(db, ctx.userId)
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
      // Excludes the body message — the body IS the first message; the badge
      // shows reply count, so a freshly created post reads 0.
      messageCount: 0,
      lastMessageAt: message.createdAt,
      parent: { authorName, text: content.slice(0, MESSAGE_PREVIEW_LENGTH) },
      authorId: ctx.userId,
      authorAvatar,
      tags: [],
      preview: content.slice(0, MESSAGE_PREVIEW_LENGTH),
      // A fresh post's only participant is its creator (just enrolled above).
      participants: [{ id: ctx.userId, name: authorName, avatar: authorAvatar }],
    },
  }, 201)
})
