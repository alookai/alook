import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  withD1Retry,
  nonIdempotentWriteAllowed,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_PREVIEW_LENGTH,
  WS_EVENTS,
  slugify,
  stripRefTokens,
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

  // `withD1Retry` (D1-armor: no-fallback forum-post list read; retry to truth).
  let childChannels = await withD1Retry(
    () =>
      queries.communityChannel.listChildChannels(db, channelId, {
        archived: false,
        type: "forum_post",
      }),
    { route: "channels/posts/list" },
  )

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
  const creators = creatorIds.length > 0
    ? await withD1Retry(() => queries.user.getUsersByIds(db, creatorIds), { route: "channels/posts/creators" })
    : []
  const creatorMap = new Map(creators.map((u) => [u.id, u]))

  // Batch-fetch first message for each post channel
  const postChannelIds = childChannels.map((t) => t.id)
  const firstMessages = postChannelIds.length > 0
    ? await withD1Retry(() => queries.communityMessage.getFirstMessageByChannelIds(db, postChannelIds), { route: "channels/posts/first-messages" })
    : []
  const previewMap = new Map(firstMessages.map((m) => [m.channelId, m.content]))

  // Batch-fetch each post's participant (notify) set for the card AvatarGroup.
  // A post's participants are the people actually involved (creator + whoever
  // spoke / was mentioned / was added), the same set fan-out notifies. Grouped
  // by channel id and ordered by `addedAt` so the creator (earliest "spoke"
  // row) leads.
  const participantRows = postChannelIds.length > 0
    ? await withD1Retry(() => queries.communityThread.listParticipantsForChannels(db, postChannelIds), { route: "channels/posts/participants" })
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
    // Strip ref tokens BEFORE slicing so `{…}(channel/id)` becomes `#name` (never
    // a raw token, and never a token cut mid-string by the length cap).
    const preview = stripRefTokens(previewMap.get(t.id) ?? "").slice(0, MESSAGE_PREVIEW_LENGTH)
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

  // Dedupe the slug within this forum so the post's name anchor
  // (`/server/forum/<post>`) is a unique, resolvable address. Post names are
  // NOT covered by the per-server unique index (top-level channels only), so
  // uniqueness is enforced here, mirroring top-level channel naming: `ideas`
  // → `ideas-2` → `ideas-3`. `name` is already slugified (no `/`/`#`/space),
  // so the anchor round-trips cleanly through parseRef/formatRef.
  const uniqueName = await queries.communityChannel.dedupeChildChannelSlug(db, channelId, name)

  // Create child channel for the forum post. Tags are NOT set at creation —
  // they're added afterward from the post card's tag dialog.
  // `nonIdempotentWriteAllowed` (state 4b), NOT retried: forum-post names are
  // NOT covered by the per-server unique index (top-level channels only — see
  // the dedupe note above), so createChannel here has no unique guard and a
  // blind retry would create a SECOND post (the retry would even re-dedupe to a
  // different slug). Duplicate = a visible, deletable extra post (not silent),
  // so a comment suffices; a transient surfaces as a retryable 500.
  const postChannel = await nonIdempotentWriteAllowed(
    {
      reason:
        "createChannel for a forum_post has no unique guard (post names aren't in the per-server unique index); a retry would create a second post",
    },
    () =>
      queries.communityChannel.createChannel(db, {
        serverId: channel.serverId,
        parentChannelId: channelId,
        name: uniqueName,
        type: "forum_post",
        creatorId: ctx.userId,
      }),
  )

  // Create the first message in the post through the unified pipeline. Route as
  // `kind:"forum_post"` (NOT `kind:"channel"`) so the notify-set enroll runs
  // exactly like a thread: the creator joins as "spoke" AND anyone the post
  // body @-mentions joins as "mention" — so a person @-ed while creating the
  // post lands in the members panel, matching reply behavior. `mentionType`
  // still flows through for @everyone. `skipChildChannelUpdate` suppresses ONLY
  // the parent CHILD_CHANNEL_UPDATE WS tick (enroll is unaffected) — this route
  // already emits its own CHILD_CHANNEL_CREATE for the new post below, and the
  // two would collide. The emitted MESSAGE_CREATE is deduped by id on the
  // client against that CHILD_CHANNEL_CREATE.
  const created = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: {
      kind: "forum_post",
      channelId: postChannel.id,
      parentChannelId: channelId,
      serverId: channel.serverId,
    },
    body: { content, attachments: body.attachments, mentionType: body.mentionType },
    skipChildChannelUpdate: true,
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
      parent: { authorName, text: stripRefTokens(content).slice(0, MESSAGE_PREVIEW_LENGTH) },
      authorId: ctx.userId,
      authorAvatar,
      tags: [],
      preview: stripRefTokens(content).slice(0, MESSAGE_PREVIEW_LENGTH),
      // A fresh post's only participant is its creator (just enrolled above).
      participants: [{ id: ctx.userId, name: authorName, avatar: authorAvatar }],
    },
  }, 201)
})
