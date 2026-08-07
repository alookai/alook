import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  isUniqueConstraintError,
  MAX_EMOJI_BYTES,
  WS_EVENTS,
} from "@alook/shared"
import type { Database } from "@alook/shared"
import type { CommunityActor } from "@/lib/middleware/community-actor"
import { fanOutToChannel, fanOutToDM } from "@/lib/community/fanout"
import {
  requireChannelMember,
  requireDMAccess,
} from "@/lib/community/permissions"
import { requireReactableSurface } from "@/lib/community/channel-write-guard"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"

// A bot addresses by ref-in-body (`{ channel, seq }`, the folded `reactAdd`
// verb); the path `[id]` is then the `resolve` placeholder (a ref carries `/`
// and can't sit in a path segment). A human/web caller puts the real messageId
// in the path.
const REF_PLACEHOLDER_ID = "resolve"

type AccessOk = { ok: true; channelId: string; isDm: boolean }
type AccessErr = { ok: false; status: 400 | 401 | 403 | 404; error: string }

type MsgIdOk = { ok: true; messageId: string }
type MsgIdErr = { ok: false; status: number; error: string }

/**
 * Resolve the target messageId for a reaction, one addressing input per actor:
 *  - human/web: real messageId in the path (unchanged — byte-identical to pre-
 *    5c; `authorizeReaction` below then re-resolves the message → channel and
 *    keeps the 403/404 split web needs).
 *  - bot/CLI: ref-in-body `{ channel, seq }` (the folded `reactAdd`). The ref
 *    goes through `resolveTargetForMember` FIRST (member-scoped inner-join, so
 *    an unreachable channel yields ZERO rows → 404 BEFORE any message lookup),
 *    then the channel-scoped `getMessageByChannelAndSeq` (a seq absent in that
 *    channel → 404). So a bot NEVER sees the mask's 403 for a known-but-non-
 *    member channel — it 404s at resolve first (①-C uniform existence-mask; the
 *    403 leak 5c newly exposed by opening this route to bot credentials,
 *    Blondie/Aigneis #294/#295). Reaction is add-only for bots (no
 *    create-if-missing — a ref to a nonexistent DM/thread 404s, never creates).
 */
async function resolveReactionMessageId(
  db: Database,
  actor: CommunityActor,
  ctx: { params?: { id?: string } },
  raw: unknown,
): Promise<MsgIdOk | MsgIdErr> {
  if (actor.kind === "bot") {
    const body = (raw ?? {}) as { channel?: unknown; seq?: unknown }
    const ref = typeof body.channel === "string" ? body.channel : ""
    const seq = typeof body.seq === "number" ? body.seq : NaN
    if (!ref) return { ok: false, status: 400, error: "channel ref required" }
    if (!Number.isInteger(seq) || seq <= 0) return { ok: false, status: 400, error: "valid seq required" }

    const resolved = await resolveTargetForMember(db, actor.userId, ref, {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    if ("error" in resolved) return { ok: false, status: resolved.error, error: resolved.message }

    const message = await queries.communityMessage.getMessageByChannelAndSeq(db, { channelId: resolved.channelId }, seq)
    if (!message) return { ok: false, status: 404, error: "message not found" }
    return { ok: true, messageId: message.id }
  }

  const pathId = ctx.params?.id
  if (typeof pathId !== "string" || !pathId || pathId === REF_PLACEHOLDER_ID) {
    return { ok: false, status: 400, error: "missing message id" }
  }
  return { ok: true, messageId: pathId }
}

/**
 * Resolve the message and verify the caller can react.
 * Reactions follow the same access rules as reading the message itself —
 * for a DM channel, that also requires the other user not to have blocked the
 * caller.
 */
async function authorizeReaction(
  db: Database,
  messageId: string,
  userId: string,
): Promise<AccessOk | AccessErr> {
  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return { ok: false, status: 404, error: "message not found" }

  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  const reactable = requireReactableSurface(channelType)
  if (!reactable.ok) return { ok: false, status: reactable.status, error: reactable.error }
  if (channelType === "dm") {
    const check = await requireDMAccess(db, message.channelId, userId)
    if (!check.ok) return check
    return { ok: true, channelId: message.channelId, isDm: true }
  }
  const check = await requireChannelMember(db, message.channelId, userId)
  if (!check.ok) return check
  return { ok: true, channelId: message.channelId, isDm: false }
}

/**
 * Message-keyed reaction door (route/disc trunk — message-keyed faces dual-actor).
 * withCommunityActor: both human (session) and bot (crk_, the folded `reactAdd`
 * verb) hit this one route. Authorization is credential-scoped — `authorizeReaction`
 * resolves the message → its channel → the per-surface gate (requireDMAccess for a
 * DM incl block, requireChannelMember otherwise) keyed on `ctx.actor.userId`, so a
 * bot reaction runs the SAME mask a human does (no bot bypass). The bot's ref+seq→
 * messageId resolution happens upstream at the flat-verb→door retarget (proxy); this
 * route is message-keyed (messageId in path) for both actors.
 */
export const PUT = withCommunityActor(async (req: NextRequest, ctx) => {
  const rawEmoji = ctx.params?.emoji
  if (!rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)
  if (Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    return writeError("emoji too long", 400)
  }

  const userId = ctx.actor.userId
  const db = getDb(ctx.env.DB)

  // Target messageId: bot ref+seq (member-scoped → 404), human path id. A bot
  // body is `{ channel, seq, emoji }` — emoji is already the path segment, so
  // only channel+seq are read from the body here.
  let raw: unknown = undefined
  if (ctx.actor.kind === "bot") {
    try {
      raw = await req.json()
    } catch {
      return writeError("invalid JSON body", 400)
    }
  }
  const msgId = await resolveReactionMessageId(db, ctx.actor, ctx, raw)
  if (!msgId.ok) return writeError(msgId.error, msgId.status)
  const messageId = msgId.messageId

  const access = await authorizeReaction(db, messageId, userId)
  if (!access.ok) return writeError(access.error, access.status)

  let reaction
  try {
    reaction = await queries.communityReaction.addReaction(db, {
      messageId,
      userId,
      emoji,
    })
  } catch (e) {
    if (isUniqueConstraintError(e)) return writeJSON({ ok: true, duplicate: true })
    throw e
  }

  const event = {
    type: WS_EVENTS.REACTION_ADD as typeof WS_EVENTS.REACTION_ADD,
    messageId,
    userId,
    emoji,
    channelId: access.channelId,
  }

  if (access.isDm) {
    fanOutToDM(access.channelId, event, { excludeUserId: userId })
  } else {
    fanOutToChannel(access.channelId, event, { excludeUserId: userId })
  }

  return writeJSON(reaction)
})

export const DELETE = withCommunityActor(async (_req: NextRequest, ctx) => {
  // Defensive bot→404 (①-C): there is NO bot react-REMOVE verb in the ServerApi
  // contract (only `reactAdd`), so no bot caller reaches this arm today and the
  // retarget wires none. 5c opened bot credentials on the route; collapse the
  // bot arm to an opaque 404 rather than let a future react-remove verb slip
  // through to the messageId-in-path `authorizeReaction` (whose 403 would leak
  // message existence to a bot). Human path unchanged.
  if (ctx.actor.kind === "bot") return writeError("not found", 404)

  const messageId = ctx.params?.id
  const rawEmoji = ctx.params?.emoji
  if (!messageId || !rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)

  const userId = ctx.actor.userId
  const db = getDb(ctx.env.DB)
  const access = await authorizeReaction(db, messageId, userId)
  if (!access.ok) return writeError(access.error, access.status)

  await queries.communityReaction.removeReaction(db, {
    messageId,
    userId,
    emoji,
  })

  const event = {
    type: WS_EVENTS.REACTION_REMOVE as typeof WS_EVENTS.REACTION_REMOVE,
    messageId,
    userId,
    emoji,
    channelId: access.channelId,
  }

  if (access.isDm) {
    fanOutToDM(access.channelId, event, { excludeUserId: userId })
  } else {
    fanOutToChannel(access.channelId, event, { excludeUserId: userId })
  }

  return new Response(null, { status: 204 })
})
