import { COMMUNITY_RESOURCE_CONTRACT_VERSION, MAX_FORUM_TAG_LENGTH, queries, requestsCommunityContract, requestedCommunityContract } from "@alook/shared"
import { NextRequest, NextResponse } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError } from "@/lib/middleware/helpers"
import { getDb, getPrimaryDb } from "@/lib/db"
import { parseCommunityMessageWindow } from "@/lib/community/messages"
import { readCommunityMessageWindow } from "@/lib/community/message-window.server"
import { readCommunityConversationEntry } from "@/lib/community/conversation-entry.server"
import { writeCommunityMessagesRead, writeCommunityConversationEntryRead } from "@/lib/community/read-contract"
import { resolveMessageTarget } from "@/lib/community/message-door"
import { handleHumanSend, handleBotSend } from "@/lib/community/message-send.server"

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
  if (params.has("entry") && (params.get("entry") !== "1" || ctx.actor.kind !== "human" || requestedCommunityContract(req.headers) !== COMMUNITY_RESOURCE_CONTRACT_VERSION)) {
    return writeError("entry requires current human resource contract", 400)
  }
  // TODO(route-disc): unify the two response projections.
  // Auth/pagination-scope already single-source (one mask, one channel-scoped set);
  // the remaining fork is PROJECTION ONLY — human: enrichMessages→{messages},
  // bot: toAgentMessages→{items}. Kept split today because {items}+agent-message
  // is the daemon/CLI contract (inboxPull-shape reserved). Converge when the
  // agent-message form and enrich can share one projection (or CLI contract lifts).
  // Invariant to preserve on merge: both arms hit the SAME channel-scoped row-set
  // (set-equality) — only pagination-window + projection differ, no arm adds a where.

  // ── bot arm: seq-anchored window → agent-message projection → {items} ──
  if (ctx.actor.kind === "bot" && !requestsCommunityContract(req.headers)) {
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
  let window
  try { window = parseCommunityMessageWindow(params) } catch (error) { return writeError(error instanceof Error ? error.message : "invalid message window", 400) }
  const rawTag = params.get("tag")
  const tag = rawTag?.trim().toLowerCase()
  if (rawTag !== null && !tag) return writeError("tag must not be empty", 400)
  if (tag && tag.length > MAX_FORUM_TAG_LENGTH) return writeError(`tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters`, 400)

  if (params.get("entry") === "1") {
    const result = await readCommunityConversationEntry(db, {
      viewerId: userId, target: resolved.value, window, tag, preferTail: params.get("window") === "tail",
    })
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.details ? { details: result.details } : {}) }, { status: result.status })
    return writeCommunityConversationEntryRead(result.entry)
  }

  const result = await readCommunityMessageWindow(db, {
    viewerId: userId, target: resolved.value, window, tag, contract: COMMUNITY_RESOURCE_CONTRACT_VERSION,
  })
  if (!result.ok) return NextResponse.json({ error: result.error, details: result.details }, { status: result.status })
  return writeCommunityMessagesRead(req, channelId, result.page)
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
 * by `requireMessageSurfaceCommunicationAccess` (via resolveMessageTarget) — the dispatch
 * subsumes the member check AND returns the channel, so there is EXACTLY ONE
 * authorization entry (no standalone member/DM gate remains — a second gate
 * would be a bypass of the single mask). A bot hitting this id route passes the
 * SAME mask (never skipped because machine-token — ASSERT 1 ①-C).
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  // A send is read-before-write: authorization, alignment, retries, and the
  // blocked response all depend on the latest committed channel state. Start
  // this request on primary so a lagging replica cannot supply a stale CAS
  // boundary or stale `latestSeq`; subsequent reads remain sequentially
  // consistent within the same D1 session.
  const db = getPrimaryDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 })
  }

  if (ctx.actor.kind === "bot") {
    return handleBotSend(db, ctx.actor.userId, ctx.env, raw)
  }
  const pathId = ctx.params?.id
  if (!pathId || pathId === REF_PLACEHOLDER_ID) return NextResponse.json({ error: "missing channel id" }, { status: 400 })
  return handleHumanSend(db, ctx.actor.userId, ctx.env, { id: pathId }, raw, COMMUNITY_RESOURCE_CONTRACT_VERSION)
})
