import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentSendRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"
import { createCommunityMessage, type MessageTarget } from "@/lib/community/message-handler"

/**
 * POST /api/community/agent/send — plan §7.
 *
 * Single resolve, WITH create flags (`createDmIfMissing`/`createThreadIfMissing:
 * true`), rather than the plan's literal read-only-then-mutating double
 * resolve. This is intentionally simplified but behaviorally identical: a
 * DM/thread row can only be auto-created when it has NEVER had a message
 * sent to it, which means that scope's `community_message_seq` counter is
 * necessarily absent (`latestSeq === 0`) — i.e. it is IMPOSSIBLE for the
 * alignment gate to block a send into a target that doesn't exist yet
 * (blocking requires `latestSeq > seen`, and `seen >= 0` always). So
 * auto-create can never fire on a request this gate would have blocked
 * anyway — a single resolve is safe and avoids a redundant DB round trip.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
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

  const resolved = await resolveTargetForMember(db, ctx.botUserId, body.channel, {
    createDmIfMissing: true,
    createThreadIfMissing: true,
    callerKind: "bot",
  })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  const scopeTarget =
    resolved.kind === "dm" ? { dmConversationId: resolved.dmConversationId } : { channelId: resolved.channelId }

  // Channel-alignment gate (plan §7, debt #2 corrected) — no bypass. The
  // server is the source of truth for the "seen" waterline: a client that
  // omits `seenUpToSeq` is checked against its OWN tracked `lastReadSeq`,
  // never allowed to skip the gate by simply not sending the field.
  const scopeKey = queries.communityMessage.scopeKeyForTarget(scopeTarget)
  const [latestSeq, readState] = await Promise.all([
    queries.communityAgentInbox.getLatestSeqForScope(db, scopeKey),
    queries.communityReadState.getReadState(db, { userId: ctx.botUserId, ...scopeTarget }),
  ])
  const seen = body.seenUpToSeq ?? readState?.lastReadSeq ?? 0
  if (latestSeq > seen) {
    return NextResponse.json({
      state: "blocked",
      reason: "unaligned",
      unreadCount: latestSeq - seen,
      latestSeq,
    })
  }

  // Permission gate + MessageTarget reconstruction (plan §5 — threads are
  // channels for routing, but `createCommunityMessage` needs the full
  // 3-variant union to fire `CHILD_CHANNEL_UPDATE` for thread replies).
  let target: MessageTarget
  if (resolved.kind === "dm") {
    const gate = await requireDMParticipant(db, resolved.dmConversationId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    target = { kind: "dm", dmId: resolved.dmConversationId, otherUserId: resolved.otherUserId }
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    const channel = gate.value
    target = channel.parentChannelId
      ? { kind: "thread", channelId: channel.id, parentChannelId: channel.parentChannelId, serverId: channel.serverId }
      : { kind: "channel", channelId: channel.id, serverId: channel.serverId }
  }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.botUserId,
    target,
    body: { content: body.content.text },
    source: "cli",
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  const message = await queries.communityAgentInbox.toAgentMessage(db, result.row, ctx.botUserId)
  return NextResponse.json({ state: "sent", message })
})
