import {
  queries,
  extractMentionedUserIds,
  isMentionType,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  WS_EVENTS,
} from "@alook/shared"
import type { MentionType } from "@alook/shared"
import type { Database } from "@alook/shared"
import { fanOutToChannel, fanOutToDM } from "./fanout"
import { broadcastToUser } from "../broadcast"
import { mapMessageForWs } from "./message-payload"

export type MessageTarget =
  | { kind: "channel"; channelId: string; serverId: string }
  | {
      kind: "thread"
      channelId: string
      parentChannelId: string
      serverId: string
    }
  | { kind: "dm"; dmId: string; otherUserId: string }

type IncomingAttachment = {
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

type CreateMessageError = {
  ok: false
  status: 400
  error: string
}

type CreateMessageOk = {
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
  const mentionType: MentionType | undefined =
    target.kind !== "dm" && isMentionType(body.mentionType)
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

  // Reply target for mention broadcasts. Scope-check against the current
  // target so a caller can't attach a preview of a message from a different
  // DM/channel by passing its id. The payload-side reply preview is built
  // from the same scope-checked map by `mapMessageForWs` below.
  const replyMap = new Map<string, { id: string; authorName: string; content: string | null }>()
  const replyTargets = new Set<string>()
  if (row.replyToId) {
    // single-id path — see `dm/[id]/messages/route.ts` / `channels/[id]/messages/route.ts` for the batched N-id path
    const replyMsg = await queries.communityMessage.getMessage(db, row.replyToId)
    const inScope = replyMsg
      ? target.kind === "dm"
        ? replyMsg.dmConversationId === target.dmId
        : replyMsg.channelId === target.channelId
      : false
    if (replyMsg && inScope) {
      replyMap.set(replyMsg.id, {
        id: replyMsg.id,
        authorName: replyMsg.authorName,
        content: replyMsg.content,
      })
      if (replyMsg.authorId && replyMsg.authorId !== authorId) {
        replyTargets.add(replyMsg.authorId)
      }
    }
  }

  // Mention extraction is channel/thread only — DMs have no member roster
  // and no @-anyone semantics.
  //
  // Split the query by need: broadcast wants userIds only; @-candidate
  // extraction wants (userId, userName) tuples. When both branches fire we
  // still issue a single `listMembers` call — it's a superset of userIds,
  // never double-query.
  const mentionTargets = new Set<string>()
  if (target.kind !== "dm") {
    const hasAtMention = typeof row.content === "string" && row.content.includes("@")
    if (hasAtMention) {
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
    } else if (mentionType === "everyone" || mentionType === "here") {
      const userIds = await queries.communityMember.listMemberUserIds(db, target.serverId)
      for (const uid of userIds) {
        if (uid !== authorId) mentionTargets.add(uid)
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
    const authorName = row.authorName
    const channelIdForBroadcast =
      target.kind === "dm" ? undefined : target.channelId
    for (const userId of [...liveMentions, ...liveReplies]) {
      broadcastToUser(userId, {
        type: WS_EVENTS.MENTION_CREATE,
        userId,
        messageId: row.id,
        ...(channelIdForBroadcast ? { channelId: channelIdForBroadcast } : {}),
        authorName,
      }).catch(() => {})
    }
  }

  // Fan-out + per-kind side effects (DM peer ping, parent CHILD_CHANNEL_UPDATE).
  const messagePayload = mapMessageForWs(row, {
    replyMap,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      contentType: a.contentType ?? undefined,
      size: a.size ?? undefined,
    })),
  })

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
    }).catch(() => {})
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
        },
        { excludeUserId: authorId },
      ).catch(() => {})
    }
  }

  return { ok: true, row, attachments }
}
