import { NextRequest, NextResponse } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry, CommunityAgentSendRequestSchema, utcDayKey } from "@alook/shared"
import {
  parseCursor,
  parseAnchor,
  parsePageSize,
  buildPaginatedResponse,
  buildAnchorResponse,
  buildSinceResponse,
} from "@/lib/community/messages"
import { enrichMessages } from "@/lib/community/enrich-messages"
import { requireChannelMember } from "@/lib/community/permissions"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage } from "@/lib/community/message-handler"
import {
  parseTargetDescriptor,
  resolveMessageTarget,
  type MessageTargetDescriptor,
} from "@/lib/community/message-door"

// A bot addresses by ref-in-body; the path `[id]` is then a placeholder
// (`channels/resolve/messages`) since a ref carries `/` and can't sit in a path
// segment. A human/web caller puts the real channelId in the path. This is the
// one door's single addressing input — id (path) xor ref (body), Gener #752.
const REF_PLACEHOLDER_ID = "resolve"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const params = req.nextUrl.searchParams
  const anchorId = parseAnchor(params.get("anchor"))
  const since = parseCursor(params.get("since"))
  const cursor = parseCursor(params.get("cursor"))
  const pageSize = parsePageSize(params.get("limit"))

  // Anchor branch: resolve the target message inside the channel scope first
  // (a scope-first lookup — see AGENTS.md "scope the queries before"), then
  // fetch the centered window and enrich.
  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { channelId })
    if (!anchor) return writeError("anchor not found", 404)

    const around = await queries.communityMessage.listMessagesAround(db, {
      channelId,
      anchor: { createdAt: anchor.createdAt, id: anchor.id },
      limit: pageSize,
    })

    const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
      around.older,
      around.newer,
      { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
    )

    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
    return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
  }

  // Since branch: strictly-newer diff for cache hydration & WS-reconnect
  // catch-up. Rows arrive ASC directly from the query; no reverse pass here.
  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, {
      channelId,
      since,
      limit: pageSize,
    })
    const { items, hasMoreNewer, newerCursor, hasMoreOlder, olderCursor } = buildSinceResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
    return writeJSON({ messages, hasMoreNewer, newerCursor, hasMoreOlder, olderCursor, latestSeq })
  }

  // Legacy branch (unchanged behavior beyond `latestSeq` addition): newest page
  // via DESC + one-extra-row probe, response items reversed to ASC.
  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items.slice().reverse())
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

  const body = raw as { nonce?: unknown }
  const clientNonce = typeof body?.nonce === "string" ? body.nonce : undefined

  const result = await createCommunityMessage({
    db,
    authorId: userId,
    target: resolved.value.target,
    body: raw as Record<string, unknown>,
    source: "web",
    clientNonce,
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
      () => queries.communityAttachment.findPendingAttachmentsForBot(db, { ids: body.attachments, uploaderId: botUserId, targetId: channelId }),
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
