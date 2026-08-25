import { NextRequest, NextResponse } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry, CommunityAgentSendRequestSchema, MAX_FORUM_TAG_LENGTH, utcDayKey } from "@alook/shared"
import {
  parseCursor,
  parseAnchor,
  parsePageSize,
  buildPaginatedResponse,
  buildAnchorResponse,
  buildSinceResponse,
} from "@/lib/community/messages"
import { enrichMessages } from "@/lib/community/enrich-messages"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage, getCommunityMessageReplay } from "@/lib/community/message-handler"
import { createMessageWithThread } from "@/lib/community/create-channels"
import {
  resolveMessageTarget,
  type MessageTargetDescriptor,
} from "@/lib/community/message-door"

// A bot addresses by ref-in-body; the path `[id]` is then a placeholder
// (`channels/resolve/messages`) since a ref carries `/` and can't sit in a path
// segment. A human/web caller puts the real channelId in the path. This is the
// one door's single addressing input — id (path) xor ref (body), Gener #752.
const REF_PLACEHOLDER_ID = "resolve"

// Parse a non-negative integer query param (bot read's seq anchors/limit).
// Returns undefined for absent/invalid so downstream defaults apply.
function parseIntParam(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/**
 * GET /api/community/channels/{id}/messages — the canonical read door (GET/read
 * convergence, (A) ruled Melly #237). Dual-actor: human/web pages by createdAt
 * → enrich → {messages}; bot/CLI pages by seq → agent-message → {items} (the
 * former flat `read` verb, daemon contract). Both arms:
 *   - go through the SINGLE authorization entry (resolveMessageTarget →
 *     requireMessageSurfaceAccess) — no standalone requireChannelMember (§3);
 *     a bot passes the SAME mask (①-C read side, never skipped);
 *   - query the SAME channel-scoped set (same channelId + actor scope) — the
 *     response-form branch is a projection/pagination difference ONLY, never a
 *     visibility/set difference (Ingaborg ★ / Aigneis ④);
 * The branch key is the CREDENTIAL actor.kind, never a field (Aigneis ②); auth
 * failures (404/403) happen at the mask BEFORE the branch, opaque for both arms
 * (Aigneis ③). Read NEVER creates: the descriptor built here carries no
 * create-if-missing (structurally, not just create=false — Aigneis #246 ⑤); a
 * ref to a nonexistent target is a 404, not a read-then-create.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const params = req.nextUrl.searchParams

  // Single authorization entry, shared by both arms. Human: id from the path.
  // Bot: ref from the query (?ref=), a ref carrying `/` can't sit in the path
  // segment. NO create-if-missing on either — read is pure addressing.
  const refParam = params.get("ref")
  const descriptor = ctx.actor.kind === "bot" && refParam
    ? { ref: refParam }
    : { id: ctx.params?.id === REF_PLACEHOLDER_ID ? "" : (ctx.params?.id ?? "") }
  if (descriptor.id !== undefined && !descriptor.id) {
    return NextResponse.json({ error: "missing channel id" }, { status: 400 })
  }

  const resolved = await resolveMessageTarget(db, ctx.actor.userId, descriptor, ctx.actor.kind)
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, ...(resolved.hint ? { hint: resolved.hint } : {}) },
      { status: resolved.status },
    )
  }
  const channelId = resolved.value.target.channelId
  // The surface trait drives enrichment: a DM (type=dm) skips thread indicators
  // and hydrates friend-approval cards; a channel does the opposite. Derived
  // from the resolved surface (not re-tested) so the human read is byte-
  // identical whether the caller addressed a DM by its channelId here or via the
  // old dm/[id]/messages route (which passed isDm:true explicitly).
  const isDm = resolved.value.isDm
  const isForum = resolved.value.target.kind === "forum"

  // TODO(route-disc): unify the two response projections.
  // Auth/pagination-scope already single-source (one mask, one channel-scoped set);
  // the remaining fork is PROJECTION ONLY — human: enrichMessages→{messages},
  // bot: toAgentMessages→{items}. Kept split today because {items}+agent-message
  // is the daemon/CLI contract (inboxPull-shape reserved). Converge when the
  // agent-message form and enrich can share one projection (or CLI contract lifts).
  // Invariant to preserve on merge: both arms hit the SAME channel-scoped row-set
  // (set-equality) — only pagination-window + projection differ, no arm adds a where.

  // ── bot arm: seq-anchored window → agent-message projection → {items} ──
  if (ctx.actor.kind === "bot") {
    const readParams = {
      before: parseIntParam(params.get("before")),
      after: parseIntParam(params.get("after")),
      around: parseIntParam(params.get("around")),
      limit: parseIntParam(params.get("limit")),
    }
    const { items, hasMore, latestSeq } = await queries.communityAgentInbox.listMessagesBySeq(
      db,
      { channelId },
      readParams,
    )
    const messages = await queries.communityAgentInbox.toAgentMessages(db, items, ctx.actor.userId)
    return NextResponse.json({ items: messages, hasMore, ...(latestSeq !== undefined ? { latestSeq } : {}) })
  }

  // ── human arm: createdAt-anchored window → enrich → {messages} ──
  const userId = ctx.actor.userId
  const anchorId = parseAnchor(params.get("anchor"))
  const since = parseCursor(params.get("since"))
  const cursor = parseCursor(params.get("cursor"))
  const rawTag = params.get("tag")
  const tag = rawTag?.trim().toLowerCase()
  if (rawTag !== null && !tag) return writeError("tag must not be empty", 400)
  if (tag && tag.length > MAX_FORUM_TAG_LENGTH) return writeError(`tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters`, 400)
  const pageSize = parsePageSize(params.get("limit"))

  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { channelId })
    if (!anchor) return writeError("anchor not found", 404)

    const around = await queries.communityMessage.listMessagesAround(db, {
      channelId,
      anchor: { createdAt: anchor.createdAt, id: anchor.id },
      limit: pageSize,
      tag,
    })

    const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
      around.older,
      around.newer,
      { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
    )

    const { messages, latestSeq } = await enrichMessages(db, userId, { channelId, isDm, isForum }, items)
    return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
  }

  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, {
      channelId,
      since,
      limit: pageSize,
      tag,
    })
    const { items, hasMoreNewer, newerCursor, hasMoreOlder, olderCursor } = buildSinceResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, userId, { channelId, isDm, isForum }, items)
    return writeJSON({ messages, hasMoreNewer, newerCursor, hasMoreOlder, olderCursor, latestSeq })
  }

  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
    tag,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichMessages(db, userId, { channelId, isDm, isForum }, items.slice().reverse())
  return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
})

/**
 * POST /api/community/channels/{id}/messages — the CANONICAL message door
 * (route/disc corrected direction, Melly #210): one id-in-path route serving
 * BOTH callers, the flat `send` verb folds in here (§3 replacement, Ingaborg
 * #219). Addressing is id-xor-ref, one door:
 *   - human/web: real channelId in the path.
 *   - bot/CLI: ref-in-body; the path `[id]` is the `resolve` placeholder (a ref
 *     carries `/`, can't sit in a path segment).
 *
 * Authorization is credential-defined, addressing is body/path only. First
 * segment = `withCommunityActor` credential dispatch (crk_ → bot arm; session →
 * human arm) BEFORE any field is read, so a body field can't flip the actor arm.
 *
 * §3 (Ingaborg #219): the former standalone `requireChannelMember` is REPLACED
 * by `requireMessageSurfaceAccess` (via resolveMessageTarget) — the dispatch
 * subsumes the member check AND returns the channel, so there is EXACTLY ONE
 * authorization entry (no standalone member/DM gate remains — a second gate
 * would be a bypass of the single mask). A bot hitting this id route passes the
 * SAME mask (never skipped because machine-token — ASSERT 1 ①-C).
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 })
  }

  if (ctx.actor.kind === "bot") {
    return handleBotSend(db, ctx.actor.userId, raw)
  }
  return handleHumanSend(db, ctx.actor.userId, ctx.env, ctx.params?.id, raw)
})

/**
 * Human/web arm — real channelId in the path (id descriptor). Rate-limit +
 * nonce + 201 shape preserved from the pre-fold channels POST; the raw body is
 * now schema-tightened via the door-core descriptor + createCommunityMessage's
 * own validation (the direction Ingaborg #196 flagged).
 */
async function handleHumanSend(
  db: ReturnType<typeof getDb>,
  userId: string,
  env: Env,
  pathId: string | undefined,
  raw: unknown,
): Promise<NextResponse> {
  if (!pathId || pathId === REF_PLACEHOLDER_ID) {
    return NextResponse.json({ error: "missing channel id" }, { status: 400 })
  }

  const descriptor: MessageTargetDescriptor = { id: pathId }

  const rateLimit = await checkRateLimit(env, "community:msgSend", userId)
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSec) } })
  }

  // SINGLE authorization entry — resolveMessageTarget → requireMessageSurfaceAccess
  // subsumes member/DM + returns the target (no standalone requireChannelMember).
  const resolved = await resolveMessageTarget(db, userId, descriptor, "human")
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const body = raw as { nonce?: unknown; attachments?: unknown }
  const clientNonce = typeof body?.nonce === "string" ? body.nonce : undefined
  const target = resolved.value.target

  // Reserve-by-id (route/disc step 2b): the composer uploads first (creating a
  // pending row) and sends the attachment IDS, mirroring the bot flow. Validate
  // each id against (uploader = this user, target = this channel) BEFORE the
  // message insert — the SAME `findPendingAttachmentsForSender` scope the bot arm
  // uses (the query is keyed on the `uploaderId` param, so it is actor-agnostic:
  // a stolen id owned by another user, or one pending against a different
  // target, fails the count check and rejects with a generic 400 that never
  // leaks which id). This is the human-side dual of the download door's
  // authorize-from-row confused-deputy guard.
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
      pendingAttachmentIdsToRebind: attachmentIds,
      clientNonce,
      source: "web",
    })
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })
    return NextResponse.json({
      message: created.message,
      threadId: created.thread.id,
      deduped: created.deduped,
    }, { status: created.deduped ? 200 : 201 })
  }

  const replay = await getCommunityMessageReplay({
    db,
    authorId: userId,
    channelId: target.channelId,
    clientNonce,
  })
  if (replay) {
    return NextResponse.json({ message: replay.row, deduped: true }, { status: 200 })
  }

  if (attachmentIds.length > 0) {
    const channelId = target.channelId
    const rows = await withD1Retry(
      () => queries.communityAttachment.findPendingAttachmentsForSender(db, { ids: attachmentIds, uploaderId: userId, targetId: channelId }),
      { route: "community/messages:human-attachments" },
    )
    if (rows.length !== attachmentIds.length) {
      return NextResponse.json({ error: "attachment not found or not attachable to this target" }, { status: 400 })
    }
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
  return NextResponse.json({ message: result.row, deduped: result.deduped }, { status: 201 })
}

/**
 * Bot arm — ref-in-body (`channel`), the former `send` verb's behavior verbatim:
 * single resolve WITH create-if-missing, channel-alignment gate, CAS via
 * `expectedSeq`, SENT-heatmap bump, agent-message response. Target resolution +
 * per-surface auth flow through the shared door-core (single mask entry).
 */
async function handleBotSend(
  db: ReturnType<typeof getDb>,
  botUserId: string,
  raw: unknown,
): Promise<NextResponse> {
  const parsed = CommunityAgentSendRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  const descriptor: MessageTargetDescriptor = {
    ref: body.channel,
    createDmIfMissing: true,
    createThreadIfMissing: true,
  }
  const resolved = await resolveMessageTarget(db, botUserId, descriptor, "bot")
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, ...(resolved.hint ? { hint: resolved.hint } : {}) },
      { status: resolved.status },
    )
  }
  const target = resolved.value.target
  const channelId = target.channelId

  // Sending into a forum's top level always opens a thread on the opener
  // message — a forum is a browsable topic list, so every message landing
  // there needs its own thread the same way a post always did. This branches
  // on the TARGET's resolved kind (set by resolveMessageTarget from the
  // channel's own stored type), never on a body field's presence — a forum
  // message always gets this treatment regardless of what fields the client
  // happened to send, and a plain channel/thread/DM never does regardless of
  // what fields it sends either. A thread can't nest another thread and a DM
  // has no thread axis, which is
  // exactly why this path is only reachable when the target's kind is
  // "forum". No alignment/hasUnread gate on this branch — opening a
  // brand-new thread is a fresh scope with no seq contention to align
  // against.
  if (target.kind === "forum") {
    const created = await createMessageWithThread({
      db,
      authorId: botUserId,
      authorKind: "bot",
      parentChannelId: channelId,
      serverId: target.serverId,
      body: { content: body.content.text },
      attachmentIds: undefined,
      pendingAttachmentIdsToRebind: body.attachments,
      clientNonce: body.nonce,
      source: "cli",
    })
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })
    const message = await queries.communityAgentInbox.toAgentMessage(db, created.message, botUserId)
    return NextResponse.json({
      state: "sent",
      message,
      threadId: created.thread.id,
      deduped: created.deduped,
    })
  }


  const replay = await getCommunityMessageReplay({
    db,
    authorId: botUserId,
    channelId,
    clientNonce: body.nonce,
  })
  if (replay) {
    const orderedAttachments = replay.attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size }))
    const message = await queries.communityAgentInbox.toAgentMessage(db, replay.row, botUserId, orderedAttachments)
    return NextResponse.json({ state: "sent", message, deduped: true })
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
    return NextResponse.json({ state: "blocked", reason: "unaligned", unreadCount: Math.max(0, latestSeq - seen), latestSeq })
  }

  if (body.attachments.length > 0) {
    const rows = await withD1Retry(
      () => queries.communityAttachment.findPendingAttachmentsForSender(db, { ids: body.attachments, uploaderId: botUserId, targetId: channelId }),
      { route: "community/messages:attachments" },
    )
    if (rows.length !== body.attachments.length) {
      return NextResponse.json({ error: "attachment not found or not attachable to this target" }, { status: 400 })
    }
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
