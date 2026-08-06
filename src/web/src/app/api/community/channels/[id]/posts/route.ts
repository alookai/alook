import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_PREVIEW_LENGTH,
} from "@alook/shared"
import { requireChannelMember, requireChannelAccess } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"
import { createMessageWithThread } from "@/lib/community/create-channels"

/**
 * A "post" is a thread rooted directly under a forum (phase2 forum≡thread —
 * zero structural difference from any other thread). This route stays a
 * dedicated human-facing door (URL unchanged, new-door∥old-door discipline)
 * but its internals now call `createMessageWithThread` — the same atomic
 * primitive the bot's send-into-forum path (`channels/[id]/messages` POST,
 * `target.kind === "forum"`) uses — instead of the deleted forum_post-
 * specific `createForumPost` core. A post's title = its opener message's
 * `content` (landing in the forum itself); its body = the thread's first
 * reply. Both callers now converge on ONE creation path.
 */

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

  // A post is now a thread rooted on an opener message landing in this
  // forum — `listChildChannels(..., {type:"thread"})` replaces the old
  // `type:"forum_post"` query; every thread under a forum IS a post (there
  // is no other reason a thread would be parented directly on a forum).
  const childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived: false,
    type: "thread",
  })

  // Unified model: a forum's posts INHERIT the forum's access (a post is not its
  // own access unit — like a thread inherits its channel). Reaching here means
  // `requireChannelAccess` already granted the viewer access to the forum (a
  // private forum 403s a non-member up front), so they see ALL of its posts. No
  // per-post membership filter.

  // Batch-fetch all creators in one query
  const creatorIds = [...new Set(childChannels.map((t) => t.creatorId).filter(Boolean) as string[])]
  const creators = creatorIds.length > 0 ? await queries.user.getUsersByIds(db, creatorIds) : []
  const creatorMap = new Map(creators.map((u) => [u.id, u]))

  // The post's TITLE is its opener message — the message this thread's own
  // `parentMessageId` points at (lives in the FORUM, not in the thread
  // itself; see createMessageWithThread's doc). Batch-fetch those by id
  // (not `getFirstMessageByChannelIds`, which reads a channel's own oldest
  // message — the opener is a row in the PARENT forum's message set, one
  // level up).
  const openerMessageIds = childChannels.map((t) => t.parentMessageId).filter((id): id is string => !!id)
  const openers = openerMessageIds.length > 0
    ? await queries.communityMessage.getMessagesByIds(db, openerMessageIds)
    : []
  const openerByMessageId = new Map(openers.map((m) => [m.id, m]))

  // The post's BODY PREVIEW is the thread's own first reply (its oldest
  // message, read from the thread channel itself — same query shape as
  // before, just no longer "the same message" as the title).
  const postChannelIds = childChannels.map((t) => t.id)
  const firstReplies = postChannelIds.length > 0
    ? await queries.communityMessage.getFirstMessageByChannelIds(db, postChannelIds)
    : []
  const previewMap = new Map(firstReplies.map((m) => [m.channelId, m.content]))

  // Tags now live on the opener message in `message_tags`, not a channel
  // column — batch-fetch by opener message id.
  const tagRows = openerMessageIds.length > 0
    ? await queries.communityMessageTag.listTagsForMessages(db, openerMessageIds)
    : []
  const tagsByMessageId = new Map<string, string[]>()
  for (const r of tagRows) {
    const list = tagsByMessageId.get(r.messageId) ?? []
    list.push(r.tag)
    tagsByMessageId.set(r.messageId, list)
  }

  // Batch-fetch each post's participant (notify) set for the card AvatarGroup.
  // A post's participants are the people actually involved (creator + whoever
  // spoke/was mentioned/was added), the same set fan-out notifies. Grouped
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

  let posts = childChannels.map((t) => {
    const creator = t.creatorId ? creatorMap.get(t.creatorId) : null
    // creator can be null if the user was deleted (channel.creatorId has ON DELETE SET NULL).
    const authorName = creator ? creator.name : ""
    const authorAvatar = creator?.image ?? avatarInitial(authorName)
    const opener = t.parentMessageId ? openerByMessageId.get(t.parentMessageId) : undefined
    const tags = (t.parentMessageId ? tagsByMessageId.get(t.parentMessageId) : undefined) ?? []
    const preview = (previewMap.get(t.id) ?? "").slice(0, MESSAGE_PREVIEW_LENGTH)
    return {
      id: t.id,
      // The card's displayed title — the opener message's content (falls
      // back to the thread's derived `name` if the opener somehow didn't
      // hydrate, so a post never renders with a blank title).
      name: opener?.content ?? t.name,
      // Excludes the opener — the thread's OWN messageCount already counts
      // only its own (reply) messages, unlike the old model where the
      // opener lived inside the post channel itself.
      messageCount: t.messageCount ?? 0,
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      parent: { authorName, text: preview },
      authorId: t.creatorId ?? "",
      authorAvatar,
      tags,
      preview,
      participants: participantsByPost.get(t.id) ?? [],
    }
  })

  if (tag) {
    posts = posts.filter((p) => p.tags.includes(tag))
  }

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

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }
  const title = body.name.trim()
  if (title.length === 0 || title.length > MAX_CHANNEL_NAME_LENGTH) {
    return writeError(`title must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
  }
  // The post BODY is now the thread's first reply, not the opener — matches
  // the bot send-into-forum path's `replyContent` (91d18e4f), which is
  // required non-empty. The existing web composer already disables submit
  // until the body composer has content (create-forum-post.tsx's
  // `canSubmit`), so this isn't a new UI-visible restriction, only a
  // backend gate catching up to what the form already enforces.
  const content = typeof body.content === "string" ? body.content : ""
  if (content.trim().length === 0) {
    return writeError("post body is required", 400)
  }
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return writeError(`content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  }

  // Reserve-by-id (route/disc step 2b): the composer uploads to the FORUM
  // channel (the thread doesn't exist yet at upload time), so pending rows
  // carry `targetId = forum channelId`. Validate each id against (uploader =
  // this user, target = this forum) before creating the post — the same
  // uploader-scoped guard the message send arm uses. Attachments land on the
  // REPLY (body) message, matching the bot arm — the opener/title carries no
  // attachments.
  const attachmentIds = Array.isArray(body.attachments)
    ? (body.attachments as unknown[]).filter((x): x is string => typeof x === "string")
    : []
  if (attachmentIds.length > 0) {
    const rows = await queries.communityAttachment.findPendingAttachmentsForSender(db, {
      ids: attachmentIds,
      uploaderId: ctx.userId,
      targetId: channelId,
    })
    if (rows.length !== attachmentIds.length) {
      return writeError("attachment not found or not attachable to this target", 400)
    }
  }

  // Create via the SAME atomic primitive the bot send-into-forum path uses —
  // title lands as the opener message in the forum, content as the thread's
  // first reply, both wrapped in one compensation chain (no half-built post
  // possible). This route keeps its own response projection; fan-out +
  // enroll are handled inside createMessageWithThread (fresh-create only).
  const result = await createMessageWithThread({
    db,
    authorId: ctx.userId,
    parentChannelId: channelId,
    serverId: channel.serverId!,
    body: { content: title, mentionType: body.mentionType },
    replyBody: { content },
    attachmentIds: undefined,
    replyAttachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
    source: "web",
  })
  if (!result.ok) return writeError(result.error, result.status)
  const postChannel = result.thread

  // Resolve author info for response
  const creator = await queries.user.getUserSelf(db, ctx.userId)
  const authorName = creator ? creator.name : ""
  const authorAvatar = creator?.image ?? avatarInitial(authorName)

  // createMessageWithThread already fires the fresh-create CHILD_CHANNEL_CREATE
  // fan-out internally — no separate emission needed here (unlike the old
  // create-forum-post.ts model, which left that to each caller).

  return writeJSON({
    post: {
      id: postChannel.id,
      name: result.message.content,
      // A fresh post's only reply is the one just created; the badge shows
      // reply count, so a freshly created post reads 0 (its own reply
      // doesn't count as a "reply" to itself in the UI's badge semantics —
      // matches the old model's "excludes the body message" comment).
      messageCount: 0,
      lastMessageAt: result.reply?.createdAt ?? result.message.createdAt,
      parent: { authorName, text: content.slice(0, MESSAGE_PREVIEW_LENGTH) },
      authorId: ctx.userId,
      authorAvatar,
      tags: [],
      preview: content.slice(0, MESSAGE_PREVIEW_LENGTH),
      // A fresh post's only participant is its creator (just enrolled by
      // createMessageWithThread's fresh-create branch).
      participants: [{ id: ctx.userId, name: authorName, avatar: authorAvatar }],
    },
  }, 201)
})
