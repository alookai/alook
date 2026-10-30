import { NextResponse } from "next/server"
import { flattenError } from "zod"
import { queries, withD1Retry, CommunityAgentSendRequestSchema, utcDayKey, WS_EVENTS, PARTICIPANT_SOURCE, COMMUNITY_CONTRACT_HEADER, COMMUNITY_RESOURCE_CONTRACT_VERSION, CommunityMessagePostedSchema, type CommunityContract } from "@alook/shared"
import { getDb } from "@/lib/db"
import { mapPostedMessageForApi, readCommunityMessageProfiles } from "./message-payload"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage, getCommunityMessageReplay } from "./message-handler"
import { createMessageWithThread } from "./create-channels"
import { resolveMessageTarget, type MessageTargetDescriptor } from "./message-door"
import { broadcastToUserSafe } from "./fanout"
import { isDuplicateBotMessage, DUPLICATE_MESSAGE_ERROR } from "./jev-send-dedup"

/**
 * Human/web arm — real channelId in the path (id descriptor). Rate-limit +
 * nonce + 201 shape preserved from the pre-fold channels POST; the raw body is
 * now schema-tightened via the door-core descriptor + createCommunityMessage's
 * own validation (the direction Ingaborg #196 flagged).
 */
export async function handleHumanSend(
  db: ReturnType<typeof getDb>,
  userId: string,
  env: Env,
  descriptor: MessageTargetDescriptor,
  raw: unknown,
  contract: CommunityContract,
): Promise<NextResponse> {
  const rateLimit = await checkRateLimit(env, "community:msgSend", userId)
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSec) } })
  }

  // SINGLE authorization entry — resolveMessageTarget's communication intent
  // subsumes member/DM friendship + returns the target (no standalone gate).
  const resolved = await resolveMessageTarget(db, userId, descriptor, "human", "communicate")
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const body = raw as { nonce?: unknown; attachments?: unknown }
  const clientNonce = typeof body?.nonce === "string" ? body.nonce : undefined
  const target = resolved.value.target

  const attachmentIds = Array.isArray(body.attachments)
    ? (body.attachments as unknown[]).filter((x): x is string => typeof x === "string")
    : []
  // A human send into a forum uses the same canonical message door and the
  // same opener+thread primitive as the bot arm. The body is sent separately
  // through this ordinary message door after the caller receives threadId.
  if (target.kind === "forum") {
    const forumBody = raw as { content?: unknown; mentionType?: unknown }
    const content = typeof forumBody.content === "string" ? forumBody.content : ""
    if (!content.trim()) return NextResponse.json({ error: "content is required" }, { status: 400 })
    const created = await createMessageWithThread({
      db,
      authorId: userId,
      authorKind: "human",
      parentChannelId: target.channelId,
      serverId: target.serverId,
      body: { content, mentionType: forumBody.mentionType },
      clientNonce,
      source: "web",
    })
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })
    const response = humanMessageConfirmation(db, contract, target.channelId, {
      message: await mapPostedMessageForApi(db, target.channelId, { ...created.message, clientNonce }, contract),
      threadId: created.thread.id,
      deduped: created.deduped,
    }, created.deduped ? 200 : 201)
    return response
  }

  const replay = await getCommunityMessageReplay({
    db,
    authorId: userId,
    channelId: target.channelId,
    clientNonce,
  })
  if (replay) {
    return humanMessageConfirmation(db, contract, target.channelId, { message: await mapPostedMessageForApi(db, target.channelId, { ...replay.row, clientNonce }, contract), deduped: true }, 200)
  }

  const result = await createCommunityMessage({
    db,
    authorId: userId,
    authorKind: "human",
    target,
    body: raw as Record<string, unknown>,
    source: "web",
    clientNonce,
    attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  const response = humanMessageConfirmation(db, contract, target.channelId, { message: await mapPostedMessageForApi(db, target.channelId, { ...result.row, clientNonce }, contract), deduped: result.deduped }, 201)
  return response
}

async function humanMessageConfirmation(db: ReturnType<typeof getDb>, contract: CommunityContract, channelId: string, payload: { message: unknown; deduped?: boolean; threadId?: string }, status: number): Promise<NextResponse> {
  const message = CommunityMessagePostedSchema.shape.message.parse(payload.message)
  const profiles = await readCommunityMessageProfiles(db, [message])
  return NextResponse.json(CommunityMessagePostedSchema.parse({ contractVersion: contract, channelId, ...payload, profiles, deduped: payload.deduped === true }), {
    status, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) },
  })
}

/**
 * Bot arm — ref-in-body (`channel`), the former `send` verb's behavior verbatim:
 * single resolve WITH create-if-missing, channel-alignment gate, CAS via
 * `expectedSeq`, SENT-heatmap bump, agent-message response. Target resolution +
 * per-surface auth flow through the shared door-core (single mask entry).
 */
export async function handleBotSend(
  db: ReturnType<typeof getDb>,
  botUserId: string,
  env: RuntimeEnv,
  raw: unknown,
): Promise<NextResponse> {
  const parsed = CommunityAgentSendRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: flattenError(parsed.error) }, { status: 400 })
  }
  const body = parsed.data

  const descriptor: MessageTargetDescriptor = {
    ref: body.channel,
    createDmIfMissing: true,
    createThreadIfMissing: true,
  }
  const resolved = await resolveMessageTarget(db, botUserId, descriptor, "bot", "communicate")
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, ...(resolved.hint ? { hint: resolved.hint } : {}) },
      { status: resolved.status },
    )
  }
  const target = resolved.value.target
  const channelId = target.channelId
  const createForumOpener = (serverId: string, expectedSeq?: number) =>
    createMessageWithThread({
      db,
      authorId: botUserId,
      authorKind: "bot",
      parentChannelId: channelId,
      serverId,
      body: { content: body.content.text },
      clientNonce: body.nonce,
      ...(expectedSeq !== undefined ? { expectedSeq } : {}),
      source: "cli",
      extraStatements: [
        queries.communityBot.bumpBotDailyActivityStatement(db, botUserId, utcDayKey(new Date()), "sent"),
      ],
    })

  const replayResponse = async () => {
    const replay = await getCommunityMessageReplay({
      db,
      authorId: botUserId,
      channelId,
      clientNonce: body.nonce,
    })
    if (!replay) return null
    if (target.kind === "forum") {
      const created = await createForumOpener(target.serverId)
      if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })
      const message = await queries.communityAgentInbox.toAgentMessage(db, created.message, botUserId)
      return NextResponse.json({
        state: "sent",
        message,
        threadId: created.thread.id,
        deduped: created.deduped,
      })
    }
    const orderedAttachments = replay.attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size }))
    const message = await queries.communityAgentInbox.toAgentMessage(db, replay.row, botUserId, orderedAttachments)
    return NextResponse.json({ state: "sent", message, deduped: true })
  }
  const replay = await replayResponse()
  if (replay) return replay

  if (target.kind === "thread") {
    const created = await withD1Retry(
      () => queries.communityThread.addThreadParticipant(db, {
        threadChannelId: channelId,
        userId: botUserId,
        source: PARTICIPANT_SOURCE.ADDED,
      }),
      { route: "community/messages:thread-auto-join" },
    )
    if (created) {
      const event = {
        type: WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE,
    relation: "notify",
    present: true,
        serverId: target.serverId,
        channelId,
        userId: botUserId,
      } as const
      const recipients = await queries.communityThread.listThreadParticipantUserIds(db, channelId)
      await Promise.all(
        [...new Set(recipients)].map((userId) => broadcastToUserSafe(userId, event)),
      )
    }
  }

  const scopeTarget = { channelId }
  const [latestSeq, readState] = await Promise.all([
    withD1Retry(() => queries.communityAgentInbox.getLatestSeqForScope(db, channelId), { route: "community/messages:latest-seq" }),
    withD1Retry(() => queries.communityReadState.getReadState(db, { userId: botUserId, ...scopeTarget }), { route: "community/messages:read-state" }),
  ])
  const seen = body.seenUpToSeq ?? readState?.lastReadSeq ?? 0
  const hasUnread = await withD1Retry(
    () => queries.communityAgentInbox.hasDeliverableUnreadForAgentScope(db, botUserId, channelId, seen),
    { route: "community/messages:has-unread" },
  )
  if (hasUnread) {
    const replay = await replayResponse()
    if (replay) return replay
    return NextResponse.json({ state: "blocked", reason: "unaligned", unreadCount: Math.max(0, latestSeq - seen), latestSeq })
  }

  if (!body.force && target.kind !== "dm" && await isDuplicateBotMessage({
    db, env, channelId, authorId: botUserId,
    content: body.content.text,
  })) {
    const replay = await replayResponse()
    if (replay) return replay
    return NextResponse.json({ error: DUPLICATE_MESSAGE_ERROR, code: "duplicate_message" }, { status: 422 })
  }

  if (target.kind === "forum") {
    const created = await createForumOpener(target.serverId, latestSeq)
    if (!created.ok) {
      if (created.status === 409) {
        const freshLatestSeq = await withD1Retry(
          () => queries.communityAgentInbox.getLatestSeqForScope(db, channelId),
          { route: "community/messages:forum-fresh-latest-seq" },
        )
        return NextResponse.json({
          state: "blocked",
          reason: "unaligned",
          unreadCount: Math.max(0, freshLatestSeq - seen),
          latestSeq: freshLatestSeq,
        })
      }
      return NextResponse.json({ error: created.error }, { status: created.status })
    }
    const message = await queries.communityAgentInbox.toAgentMessage(db, created.message, botUserId)
    return NextResponse.json({
      state: "sent",
      message,
      threadId: created.thread.id,
      deduped: created.deduped,
    })
  }

  let replyToId: string | undefined
  if (body.replyToSeq !== undefined) {
    const replyTarget = await withD1Retry(
      () => queries.communityMessage.getMessageByChannelAndSeq(db, scopeTarget, body.replyToSeq!),
      { route: "community/messages:reply-lookup" },
    )
    if (!replyTarget) {
      return NextResponse.json({ error: `reply target #${body.replyToSeq} not found in ${body.channel}` }, { status: 400 })
    }
    replyToId = replyTarget.id
  }

  const result = await createCommunityMessage({
    db,
    authorId: botUserId,
    authorKind: "bot",
    target,
    body: { content: body.content.text, replyToId },
    source: "cli",
    expectedSeq: latestSeq,
    attachmentIds: body.attachments.length > 0 ? body.attachments : undefined,
    clientNonce: body.nonce,
    extraStatements: [
      queries.communityBot.bumpBotDailyActivityStatement(db, botUserId, utcDayKey(new Date()), "sent"),
    ],
  })
  if (!result.ok) {
    if (result.status === 409) {
      const freshLatestSeq = await withD1Retry(
        () => queries.communityAgentInbox.getLatestSeqForScope(db, channelId),
        { route: "community/messages:fresh-latest-seq" },
      )
      return NextResponse.json({ state: "blocked", reason: "unaligned", unreadCount: Math.max(0, freshLatestSeq - seen), latestSeq: freshLatestSeq })
    }
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  const orderedAttachments = (result.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size }))
  const message = await queries.communityAgentInbox.toAgentMessage(db, result.row, botUserId, orderedAttachments)
  return NextResponse.json({ state: "sent", message, deduped: result.deduped })
}
