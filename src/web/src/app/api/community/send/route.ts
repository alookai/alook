import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentSendRequestSchema, utcDayKey } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveTargetById, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import { requireMessageBearingSurface } from "@/lib/community/channel-write-guard"
import { createCommunityMessage, isDmTarget, type MessageTarget } from "@/lib/community/message-handler"

/**
 * POST /api/community/send — moved from /api/community/agent/send (plan §4
 * MOVE-FLAT, §9 phase 3). Ref-addressed bot send: body `{ channel, content,
 * attachments, replyToSeq?, seenUpToSeq?, nonce? }` where `channel` is a REF
 * (kept, not id — Gener #68). This is why it CANNOT fold onto the human
 * `channels/[id]/messages` POST (Fork B): a bot holds a ref, the CLI can't
 * resolve it to a channelId, so `resolveTargetForMember` runs server-side (and
 * that resolve is also where create-DM/thread-if-missing happens). Humans send
 * via the `[id]` route; this flat verb is bot-only → human actor rejected 403
 * (`requireBot`, Gener #116). Handler body is unchanged from the /agent
 * original except the wrapper + identity source (ctx.botUserId → botUserId).
 *
 * Single resolve, WITH create flags (`createDmIfMissing`/`createThreadIfMissing:
 * true`), rather than a read-only-then-mutating double resolve. Behaviorally
 * identical: a DM/thread row can only be auto-created when it has NEVER had a
 * message sent to it, so that scope's `community_message_seq` counter is absent
 * (`latestSeq === 0`) — it is IMPOSSIBLE for the alignment gate to block a send
 * into a target that doesn't exist yet (blocking requires `latestSeq > seen`,
 * `seen >= 0` always). So auto-create never fires on a request this gate would
 * have blocked — a single resolve is safe and avoids a redundant round trip.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate0 = requireBot(ctx.actor)
  if (!gate0.ok) return gate0.response
  const botUserId = gate0.bot.userId

  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentSendRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  const resolved = body.channelId !== undefined
    ? await resolveTargetById(db, botUserId, body.channelId)
    : await resolveTargetForMember(db, botUserId, body.channel!, {
        createDmIfMissing: true,
        createThreadIfMissing: true,
        callerKind: "bot",
      })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  const scopeTarget = { channelId: resolved.channelId }

  // Channel-alignment gate (plan §7, debt #2 corrected) — no bypass. The
  // server is the source of truth for the "seen" waterline: a client that
  // omits `seenUpToSeq` is checked against its OWN tracked `lastReadSeq`,
  // never allowed to skip the gate by simply not sending the field.
  //
  // "Unaligned" means the bot has an unread message it could actually PULL —
  // so the gate shares `inboxPull`'s deliverability predicate (join baseline +
  // not-own) via `hasDeliverableUnreadForAgentScope`, NOT the raw channel
  // `nextSeq`. A late joiner (@mentioned into a channel/thread with backlog)
  // has pre-join messages the pull will never deliver; gating on `nextSeq`
  // would block it forever while the pull hands over nothing to advance its
  // `lastReadSeq` — a permanent wedge. `latestSeq` is still fetched: it feeds
  // the optimistic `expectedSeq` claim below and the `blocked` response shape.
  // Each D1 call is wrapped in withD1Retry so a transient miniflare/D1 blip
  // retries instead of hard-500ing the bot (same armor as bootstrap). The
  // alignment DECISION (blocked/unaligned) and the CAS 409 below are
  // structured returns, not thrown errors, so they never enter the retry —
  // only genuine D1 exceptions do (Cecilia red line: never retry business
  // failures).
  const [latestSeq, readState] = await Promise.all([
    withD1Retry(
      () => queries.communityAgentInbox.getLatestSeqForScope(db, resolved.channelId),
      { route: "community/send:latest-seq" },
    ),
    withD1Retry(
      () => queries.communityReadState.getReadState(db, { userId: botUserId, ...scopeTarget }),
      { route: "community/send:read-state" },
    ),
  ])
  const seen = body.seenUpToSeq ?? readState?.lastReadSeq ?? 0
  const hasUnread = await withD1Retry(
    () => queries.communityAgentInbox.hasDeliverableUnreadForAgentScope(
      db,
      botUserId,
      resolved.channelId,
      seen,
    ),
    { route: "community/send:has-unread" },
  )
  if (hasUnread) {
    return NextResponse.json({
      state: "blocked",
      reason: "unaligned",
      unreadCount: Math.max(0, latestSeq - seen),
      latestSeq,
    })
  }

  // Permission gate + MessageTarget reconstruction (plan §5 — threads are
  // channels for routing, but `createCommunityMessage` needs the full
  // 3-variant union to fire `CHILD_CHANNEL_UPDATE` for thread replies).
  let target: MessageTarget
  if (isDmTarget(resolved)) {
    const gate = await requireDMAccess(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    target = { kind: "dm", channelId: resolved.channelId, otherUserId: resolved.otherUserId }
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    const channel = gate.value
    const bearing = requireMessageBearingSurface(channel.type)
    if (!bearing.ok) return NextResponse.json({ error: bearing.error }, { status: bearing.status })
    // Only threads have a non-null parentChannelId in this path — the ref
    // resolver filters name lookups to top-level (parent_channel_id IS NULL)
    // and thread refs (`#N`) create/reuse rows with type="thread". Forum
    // posts are not addressable by any agent ref today, so no `forum_post`
    // arm is needed here.
    target = channel.parentChannelId
      ? {
          kind: "thread",
          channelId: channel.id,
          parentChannelId: channel.parentChannelId,
          serverId: channel.serverId,
        }
      : { kind: "channel", channelId: channel.id, serverId: channel.serverId }
  }

  // Attachments (plan agent-attachment-pipeline.md §Send). Validate every
  // pending id belongs to this bot, kind, and target BEFORE reservation —
  // the (uploader_id, kind, target_id) tuple is a single indexed lookup.
  // Any mismatch returns the same generic 400, no leakage of which id failed.
  const attachmentTargetId = target.channelId
  if (body.attachments.length > 0) {
    const rows = await withD1Retry(
      () => queries.communityAttachment.findPendingAttachmentsForBot(db, {
        ids: body.attachments,
        uploaderId: botUserId,
        targetId: attachmentTargetId,
      }),
      { route: "community/send:attachments" },
    )
    if (rows.length !== body.attachments.length) {
      return NextResponse.json(
        { error: "attachment not found or not attachable to this target" },
        { status: 400 },
      )
    }
  }

  // Reply/cite (plan agent-reply-cite.md §Write) — resolve the cited seq to a
  // message id WITHIN `scopeTarget` (the same channel/DM this send targets).
  // Scope-first: a `replyToSeq` can never cross-cite into another scope. A seq
  // with no matching message here (typo, wrong scope, deleted) is a hard 400 —
  // nothing is posted.
  let replyToId: string | undefined
  if (body.replyToSeq !== undefined) {
    const replyTarget = await withD1Retry(
      () => queries.communityMessage.getMessageByChannelAndSeq(
        db,
        scopeTarget,
        body.replyToSeq!,
      ),
      { route: "community/send:reply-lookup" },
    )
    if (!replyTarget) {
      return NextResponse.json(
        { error: `reply target #${body.replyToSeq} not found in ${body.channel}` },
        { status: 400 },
      )
    }
    replyToId = replyTarget.id
  }

  // `expectedSeq: latestSeq` reuses the exact snapshot the alignment gate
  // above already fetched — no new query. If another agent's `send` wins
  // the race between that snapshot and this claim, `createCommunityMessage`
  // returns a 409 and we translate it into the SAME `blocked`/`unaligned`
  // shape the gate above returns, with a freshly re-fetched `latestSeq` (the
  // stale one is now off-by-at-least-one). The daemon's existing "blocked →
  // inbox pull → retry" handling needs no changes for this (plan §4).
  // NOT wrapped in withD1Retry: createCommunityMessage is a CAS-guarded write
  // (`expectedSeq`). Blindly retrying it on a transient could re-attempt a
  // partially-applied claim; its own conflict handling returns a structured
  // 409 (below) which the daemon already realigns on. Its internal transient
  // resilience, if any, belongs inside the handler, not a blanket outer retry.
  const result = await createCommunityMessage({
    db,
    authorId: botUserId,
    target,
    body: { content: body.content.text, replyToId },
    source: "cli",
    expectedSeq: latestSeq,
    attachmentIds: body.attachments.length > 0 ? body.attachments : undefined,
    clientNonce: body.nonce,
    // Heatmap: bump this bot's per-day SENT rollup in the SAME batch as the
    // message insert (zero new round-trip). Only the bot-send routes pass this,
    // so human sends never bump; `createMessage` stays identity-agnostic.
    extraStatements: [
      queries.communityBot.bumpBotDailyActivityStatement(db, botUserId, utcDayKey(new Date()), "sent"),
    ],
  })
  if (!result.ok) {
    if (result.status === 409) {
      const freshLatestSeq = await withD1Retry(
        () => queries.communityAgentInbox.getLatestSeqForScope(db, resolved.channelId),
        { route: "community/send:fresh-latest-seq" },
      )
      return NextResponse.json({
        state: "blocked",
        reason: "unaligned",
        unreadCount: Math.max(0, freshLatestSeq - seen),
        latestSeq: freshLatestSeq,
      })
    }
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  // `createCommunityMessage` already fetched the reserved attachments via
  // listByMessageIds (ordered by `position`, which we stamped 0..N-1 in
  // caller order at reservation time). Project directly off `result.attachments`
  // instead of re-issuing the same query.
  const orderedAttachments = (result.attachments ?? []).map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
  }))

  const message = await queries.communityAgentInbox.toAgentMessage(
    db,
    result.row,
    botUserId,
    orderedAttachments,
  )
  return NextResponse.json({ state: "sent", message, deduped: result.deduped })
})
