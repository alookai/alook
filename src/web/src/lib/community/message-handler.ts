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
  width?: number
  height?: number
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
  width?: number | null
  height?: number | null
}

type FullMessageRow = NonNullable<
  Awaited<ReturnType<typeof queries.communityMessage.getMessage>>
>

type CreateMessageError = {
  ok: false
  status: 400 | 409
  error: string
}

type CreateMessageOk = {
  ok: true
  row: FullMessageRow
  attachments: CreatedAttachment[]
  /**
   * Present ONLY when the caller passed `deferBroadcast: true`. Invoking it
   * fires the WS side effects (MENTION_CREATE, MESSAGE_CREATE fan-out, DM peer
   * ping / CHILD_CHANNEL_UPDATE, bot-wake enqueue) that `createCommunityMessage`
   * would otherwise have run inline. The DM-card producers deliberately never
   * invoke this — they persist their approval-request row first and fire their
   * own minimal `DM_NEW_MESSAGE` after it commits (see plan §producer).
   */
  broadcast?: () => Promise<void>
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
  /**
   * CAS guard for the agent-send race fix
   * (plans/fix-agent-send-race-condition.md). Only the agent `send` route
   * passes this — it's the `latestSeq` snapshot that route's own alignment
   * check already computed. Omitted by every other caller (web/human sends,
   * thread posts), which keep the unconditional, always-succeeds claim.
   */
  expectedSeq?: number
  /**
   * Sets `communityMessage.type` (e.g. `"thread_created"`). Defaults to
   * `"default"` — every normal-message caller is untouched.
   */
  messageType?: string
  /**
   * Skip `@`/reply mention extraction + `communityMention` writes + the
   * `MENTION_CREATE` broadcast. System/card messages (thread_created, bot DM
   * cards) opt in — they never mention anyone.
   */
  skipMentions?: boolean
  /**
   * Skip the bot-wake enqueue that rides the `MESSAGE_CREATE` fan-out. System
   * / card messages set this — they must not wake bots.
   */
  skipWake?: boolean
  /**
   * Fan out `MESSAGE_CREATE` WITHOUT `excludeUserId`, so the author also
   * receives the event. The thread_created system message needs this — its
   * creator has no optimistic client row and must get the WS broadcast to see
   * it without a refresh.
   */
  includeAuthorInFanout?: boolean
  /**
   * Do NOT run any WS side effect inline. Instead, on success, return a
   * `broadcast` thunk on the OK result the caller can invoke once its own
   * follow-up writes have committed. Used by the DM-card producers, which
   * persist an approval-request row after the message and roll it back on
   * conflict — broadcasting before that commit would show a phantom card.
   */
  deferBroadcast?: boolean
}): Promise<CreateMessageResult> {
  const {
    db,
    authorId,
    target,
    body,
    source,
    expectedSeq,
    messageType,
    skipMentions,
    skipWake,
    includeAuthorInFanout,
    deferBroadcast,
  } = params

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

  const baseMessageData = {
    authorId,
    content,
    channelId: target.kind === "dm" ? undefined : target.channelId,
    dmConversationId: target.kind === "dm" ? target.dmId : undefined,
    replyToId,
    mentionType,
    ...(messageType !== undefined ? { type: messageType } : {}),
  }
  // `createMessage`'s overloads key off whether the `expectedSeq` property
  // is present at all, not just its runtime value — a `number | undefined`
  // typed property doesn't cleanly resolve against either overload, so the
  // pass-through branches explicitly instead of spreading `expectedSeq` in.
  const created =
    expectedSeq !== undefined
      ? await queries.communityMessage.createMessage(db, { ...baseMessageData, expectedSeq })
      : await queries.communityMessage.createMessage(db, baseMessageData)

  // Lost the CAS race (plans/fix-agent-send-race-condition.md) — zero rows
  // were written anywhere (no message, no channel/DM bump, no read-state
  // watermark). Return immediately, before attachments/mentions/fan-out/audit.
  if (created === null) {
    return { ok: false, status: 409, error: "seq_conflict" }
  }

  const attachments: CreatedAttachment[] = incomingAttachments?.length
    ? await Promise.all(
      incomingAttachments.map((att) =>
        queries.communityAttachment.createAttachment(db, {
          messageId: created.id,
          filename: att.filename,
          url: att.url,
          contentType: att.contentType,
          size: att.size,
          width: att.width,
          height: att.height,
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
  if (!skipMentions && row.replyToId) {
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
  if (!skipMentions && target.kind !== "dm") {
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

  // Private-channel scoping: a message in a channel inside a PRIVATE category
  // can only mention/reply-notify users in that channel's audience (members ∪
  // creator ∪ admins). Otherwise an @-mention would push private content into
  // a non-member's Mentions tab. Public/uncategorized channels are unchanged.
  if (target.kind !== "dm" && (mentionTargets.size > 0 || replyTargets.size > 0)) {
    const isPrivate = await queries.communityChannel.isChannelPrivate(db, target.channelId)
    if (isPrivate) {
      const audience = new Set(
        await queries.communityChannel.getPrivateChannelAudienceUserIds(db, target.channelId)
      )
      for (const id of [...mentionTargets]) if (!audience.has(id)) mentionTargets.delete(id)
      for (const id of [...replyTargets]) if (!audience.has(id)) replyTargets.delete(id)
    }
  }

  // Mention/reply ROW writes are persistence, not broadcast — they run inline
  // even under `deferBroadcast` (only the WS emissions defer). When
  // `skipMentions` both sets are empty, so these are no-ops.
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

  const messagePayload = mapMessageForWs(row, {
    replyMap,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      contentType: a.contentType ?? undefined,
      size: a.size ?? undefined,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
    })),
  })

  // Wake-dispatch row (minimal-wake-queue-unread-notice plan §1/§5) — the
  // same `row` already fetched above via `getMessage` (which now selects
  // `seq`). Passed alongside the MESSAGE_CREATE event so
  // `fanOutToChannel`/`fanOutToDM` can enqueue bot wakes using the SAME
  // recipient list already resolved for the human-WS broadcast, no second
  // membership query. Deliberately no `content`/`createdAt` — the queue
  // payload only ever carries `{ messageId, botUserId }`. Suppressed when
  // `skipWake` (system/card messages never wake bots).
  const wakeMessageRow = skipWake
    ? undefined
    : {
      id: row.id,
      seq: row.seq,
      authorId: row.authorId,
      channelId: row.channelId,
      dmConversationId: row.dmConversationId,
    }

  // `includeAuthorInFanout` fans out MESSAGE_CREATE without `excludeUserId`
  // (thread_created: the creator has no optimistic row and needs the event).
  const fanoutExclude = includeAuthorInFanout ? undefined : authorId

  // All WS side effects live here so `deferBroadcast` can hand them back as a
  // thunk instead of firing them inline.
  const doBroadcast = async (): Promise<void> => {
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

    if (target.kind === "dm") {
      fanOutToDM(
        target.dmId,
        {
          type: WS_EVENTS.MESSAGE_CREATE,
          dmConversationId: target.dmId,
          message: messagePayload,
        },
        { excludeUserId: fanoutExclude, wakeMessageRow },
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
        { excludeUserId: fanoutExclude, wakeMessageRow },
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
          { excludeUserId: fanoutExclude },
        ).catch(() => { })
      }
    }
  }

  if (deferBroadcast) {
    return { ok: true, row, attachments, broadcast: doBroadcast }
  }
  await doBroadcast()
  return { ok: true, row, attachments }
}
