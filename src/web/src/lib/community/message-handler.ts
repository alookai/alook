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
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "./audit"

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
  /** Provenance tag threaded into the bot-authored audit row's `changes` (plan §10). */
  source?: "cli" | "daemon-http" | "web"
}): Promise<CreateMessageResult> {
  const { db, authorId, target, body, source } = params

  const content = typeof body.content === "string" ? body.content : ""
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

  // A message needs either text content OR at least one attachment. Empty
  // both means the client wired something wrong — but a bare
  // attachments-only send is a legitimate flow (drop an image, hit Enter).
  if (content.trim().length === 0 && (!incomingAttachments || incomingAttachments.length === 0)) {
    return { ok: false, status: 400, error: "content or attachments required" }
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

  // Bot-authored audit (plan §10) — moved here from individual call sites
  // (the daemon bot-message route used to log this itself) so EVERY caller,
  // present and future (the CLI `send` route included), gets it for free
  // with no duplicate-call risk. There's no standalone `isBot()` helper in
  // the repo; this mirrors the check the daemon route did before its own
  // `logAudit` call was removed. Fire-and-forget — `logAudit` already
  // swallows its own errors.
  const author = await queries.user.getUserInternal(db, authorId)
  if (author?.isBot === true) {
    logAudit(db, {
      serverId: target.kind === "dm" ? null : target.serverId,
      actorId: authorId,
      action: COMMUNITY_AUDIT_ACTIONS.MESSAGE_AUTHORED_AS_BOT,
      targetType: "message",
      targetId: row.id,
      changes: JSON.stringify({
        botId: authorId,
        target: target.kind,
        targetId: target.kind === "dm" ? target.dmId : target.channelId,
        messageId: row.id,
        source: source ?? "web",
      }),
    })
  }

  // Reply target for mention broadcasts. Scoped at the query level (not a
  // post-hoc `.filter()`) so a caller can't attach a preview of a message
  // from a different DM/channel by passing its id. The payload-side reply
  // preview is built from the same scope-checked map by `mapMessageForWs`
  // below.
  const replyMap = new Map<string, { id: string; authorName: string; content: string | null }>()
  const replyTargets = new Set<string>()
  if (row.replyToId) {
    // single-id path — see `dm/[id]/messages/route.ts` / `channels/[id]/messages/route.ts` for the batched N-id path
    const scope = target.kind === "dm" ? { dmConversationId: target.dmId } : { channelId: target.channelId }
    const replyMsg = await queries.communityMessage.getMessageInScope(db, row.replyToId, scope)
    if (replyMsg) {
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
          .map((m) => ({ userId: m.userId, name: m.userName as string, discriminator: m.discriminator }))
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
      }).catch(() => { })
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

  // Wake-dispatch row (minimal-wake-queue-unread-notice plan §1/§5) — the
  // same `row` already fetched above via `getMessage` (which now selects
  // `seq`). Passed alongside the MESSAGE_CREATE event so
  // `fanOutToChannel`/`fanOutToDM` can enqueue bot wakes using the SAME
  // recipient list already resolved for the human-WS broadcast, no second
  // membership query. Deliberately no `content`/`createdAt` — the queue
  // payload only ever carries `{ messageId, botUserId }`.
  const wakeMessageRow = {
    id: row.id,
    seq: row.seq,
    authorId: row.authorId,
    channelId: row.channelId,
    dmConversationId: row.dmConversationId,
  }

  if (target.kind === "dm") {
    fanOutToDM(
      target.dmId,
      {
        type: WS_EVENTS.MESSAGE_CREATE,
        dmConversationId: target.dmId,
        message: messagePayload,
      },
      { excludeUserId: authorId, wakeMessageRow },
    ).catch(() => { })

    broadcastToUser(target.otherUserId, {
      type: WS_EVENTS.DM_NEW_MESSAGE,
      dmConversationId: target.dmId,
      message: messagePayload,
    }).catch(() => { })
  } else {
    fanOutToChannel(
      target.channelId,
      {
        type: WS_EVENTS.MESSAGE_CREATE,
        channelId: target.channelId,
        message: messagePayload,
      },
      { excludeUserId: authorId, wakeMessageRow },
    ).catch(() => { })

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
      ).catch(() => { })
    }
  }

  return { ok: true, row, attachments }
}
