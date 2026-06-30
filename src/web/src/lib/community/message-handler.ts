import {
  queries,
  extractMentionedUserIds,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MESSAGE_PREVIEW_LENGTH,
  WS_EVENTS,
} from "@alook/shared"
import type { Database } from "@alook/shared"
import { fanOutToChannel, fanOutToDM } from "./fanout"
import { broadcastToUser } from "../broadcast"

export type MessageTarget =
  | { kind: "channel"; channelId: string; serverId: string }
  | {
      kind: "thread"
      channelId: string
      parentChannelId: string
      serverId: string
    }
  | { kind: "dm"; dmId: string; otherUserId: string }

export type IncomingAttachment = {
  url: string
  filename: string
  contentType: string
  size: number
}

export type IncomingMessageBody = {
  content?: unknown
  replyToId?: unknown
  mentionType?: unknown
  attachments?: unknown
}

type CreatedAttachment = {
  id: string
  filename: string
  url: string
  contentType: string | null
  size: number | null
}

type FullMessageRow = NonNullable<
  Awaited<ReturnType<typeof queries.communityMessage.getMessage>>
>

export type CreateMessageError = {
  ok: false
  status: 400
  error: string
}

export type CreateMessageOk = {
  ok: true
  row: FullMessageRow
  attachments: CreatedAttachment[]
}

export type CreateMessageResult = CreateMessageOk | CreateMessageError

/**
 * Unified message-create pipeline for channel, thread, and DM POSTs.
 *
 * Handles request-body validation, message + attachment inserts, reply
 * resolution, mention extraction (channel/thread only — DMs only flag the
 * reply target), mention/reply broadcast, channel-or-DM fan-out, and the
 * parent-channel CHILD_CHANNEL_UPDATE that follows a thread reply.
 *
 * Each route resolves permission/target first, then delegates here.
 */
export async function createCommunityMessage(params: {
  db: Database
  authorId: string
  target: MessageTarget
  body: IncomingMessageBody
}): Promise<CreateMessageResult> {
  const { db, authorId, target, body } = params

  const content = typeof body.content === "string" ? body.content : ""
  if (!content || content.trim().length === 0) {
    return { ok: false, status: 400, error: "content is required" }
  }
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`,
    }
  }

  const incomingAttachments = Array.isArray(body.attachments)
    ? (body.attachments as IncomingAttachment[])
    : undefined
  if (
    incomingAttachments &&
    incomingAttachments.length > MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    return {
      ok: false,
      status: 400,
      error: `too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`,
    }
  }

  const replyToId =
    typeof body.replyToId === "string" ? body.replyToId : undefined
  const mentionType =
    target.kind !== "dm" && typeof body.mentionType === "string"
      ? body.mentionType
      : undefined

  const created = await queries.communityMessage.createMessage(db, {
    authorId,
    content,
    channelId: target.kind === "dm" ? undefined : target.channelId,
    dmConversationId: target.kind === "dm" ? target.dmId : undefined,
    replyToId,
    mentionType,
  })

  const attachments: CreatedAttachment[] = incomingAttachments?.length
    ? await Promise.all(
        incomingAttachments.map((att) =>
          queries.communityAttachment.createAttachment(db, {
            messageId: created.id,
            filename: att.filename,
            url: att.url,
            contentType: att.contentType,
            size: att.size,
          }),
        ),
      )
    : []

  const row = await queries.communityMessage.getMessage(db, created.id)
  if (!row) {
    // createMessage just inserted this row; getMessage returning null means
    // the DB is gone — surface that to the caller instead of inventing data.
    throw new Error("message not found after insert")
  }

  // Reply preview + reply mention target.
  let replyTo: { id: string; authorName: string; text: string } | undefined
  const replyTargets = new Set<string>()
  if (row.replyToId) {
    const replyMsg = await queries.communityMessage.getMessage(db, row.replyToId)
    if (replyMsg) {
      replyTo = {
        id: replyMsg.id,
        authorName: replyMsg.authorName ?? "Unknown",
        text: (replyMsg.content ?? "").slice(0, MESSAGE_PREVIEW_LENGTH),
      }
      if (replyMsg.authorId && replyMsg.authorId !== authorId) {
        replyTargets.add(replyMsg.authorId)
      }
    }
  }

  // Mention extraction is channel/thread only — DMs have no member roster
  // and no @-anyone semantics.
  const mentionTargets = new Set<string>()
  if (target.kind !== "dm") {
    const members = await queries.communityMember.listMembers(db, target.serverId)
    if (mentionType === "everyone" || mentionType === "here") {
      for (const m of members) {
        if (m.userId !== authorId) mentionTargets.add(m.userId)
      }
    }
    if (row.content) {
      const candidates = members
        .filter((m) => m.userId !== authorId && m.userName)
        .map((m) => ({ userId: m.userId, name: m.userName as string }))
      for (const id of extractMentionedUserIds(row.content, candidates)) {
        mentionTargets.add(id)
      }
    }
  }

  // Mention beats reply — never double-count the same user.
  for (const id of mentionTargets) replyTargets.delete(id)

  const liveMentions = [...mentionTargets]
  const liveReplies = [...replyTargets]
  if (liveMentions.length > 0) {
    await queries.communityMention.createMentions(db, {
      messageId: row.id,
      userIds: liveMentions,
      kind: "mention",
    })
  }
  if (liveReplies.length > 0) {
    await queries.communityMention.createMentions(db, {
      messageId: row.id,
      userIds: liveReplies,
      kind: "reply",
    })
  }
  if (liveMentions.length > 0 || liveReplies.length > 0) {
    const authorName = row.authorName ?? "Unknown"
    const channelIdForBroadcast =
      target.kind === "dm" ? undefined : target.channelId
    for (const userId of [...liveMentions, ...liveReplies]) {
      broadcastToUser(userId, {
        type: WS_EVENTS.MENTION_CREATE,
        userId,
        messageId: row.id,
        ...(channelIdForBroadcast ? { channelId: channelIdForBroadcast } : {}),
        authorName,
      } as never).catch(() => {})
    }
  }

  // Fan-out + per-kind side effects (DM peer ping, parent CHILD_CHANNEL_UPDATE).
  const messagePayload = buildMessagePayload(row, attachments, replyTo, target.kind)

  if (target.kind === "dm") {
    fanOutToDM(
      target.dmId,
      {
        type: WS_EVENTS.MESSAGE_CREATE,
        dmConversationId: target.dmId,
        message: messagePayload,
      },
      { excludeUserId: authorId },
    ).catch(() => {})

    broadcastToUser(target.otherUserId, {
      type: WS_EVENTS.DM_NEW_MESSAGE,
      dmConversationId: target.dmId,
      message: messagePayload,
    } as never).catch(() => {})
  } else {
    fanOutToChannel(
      target.channelId,
      {
        type: WS_EVENTS.MESSAGE_CREATE,
        channelId: target.channelId,
        message: messagePayload,
      },
      { excludeUserId: authorId },
    ).catch(() => {})

    if (target.kind === "thread") {
      const updated = await queries.communityChannel.getChannel(
        db,
        target.channelId,
      )
      fanOutToChannel(
        target.parentChannelId,
        {
          type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
          parentChannelId: target.parentChannelId,
          channelId: target.channelId,
          changes: {
            messageCount: updated?.messageCount ?? 1,
            lastMessageAt:
              updated?.lastMessageAt ?? new Date().toISOString(),
          },
        } as never,
        { excludeUserId: authorId },
      ).catch(() => {})
    }
  }

  return { ok: true, row, attachments }
}

function buildMessagePayload(
  row: FullMessageRow,
  attachments: CreatedAttachment[],
  replyTo: { id: string; authorName: string; text: string } | undefined,
  kind: MessageTarget["kind"],
) {
  const base = {
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorName ?? (kind === "dm" ? "Unknown" : ""),
    authorAvatar:
      row.authorImage ?? (row.authorName ?? "?").charAt(0).toUpperCase(),
    content: row.content,
    type: (row.type as "default" | "system" | "thread_created") ?? "default",
    createdAt: row.createdAt,
    attachments:
      attachments.length > 0
        ? attachments.map((att) => ({
            id: att.id,
            filename: att.filename,
            url: att.url,
            contentType: att.contentType ?? undefined,
            size: att.size ?? undefined,
          }))
        : undefined,
  }
  if (kind === "dm") {
    return {
      ...base,
      mentionType: row.mentionType as "everyone" | "here" | null | undefined,
      replyToId: row.replyToId,
      embeds: row.embeds ? JSON.parse(row.embeds) : undefined,
    }
  }
  if (kind === "thread") {
    return base
  }
  return {
    ...base,
    mentionType: row.mentionType as "everyone" | "here" | null,
    replyTo,
  }
}
