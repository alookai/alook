import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { resolveMessageRefForBot } from "@/lib/community/resolve-message-ref"
import {
  removeReactionForActor,
  setReactionForActor,
} from "@/lib/community/reaction-operations"

// A bot addresses by ref-in-body (`{ channel, seq }`, the folded `reactAdd`
// verb); the path `[id]` is then the `resolve` placeholder (a ref carries `/`
// and can't sit in a path segment). A human/web caller puts the real messageId
// in the path.
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
  let messageId = ctx.params?.id
  if (ctx.actor.kind === "bot") {
    const target = await resolveMessageRefForBot(
      db,
      ctx.actor.userId,
      raw,
      { requireSurfaceAccess: false },
    )
    if (!target.ok) return writeError(target.error, target.status)
    messageId = target.messageId
  }
  if (!messageId || messageId === "resolve") {
    return writeError("missing message id", 400)
  }

  const result = await setReactionForActor(db, { messageId, userId, emoji })
  if (!result.ok) return writeError(result.error, result.status)
  if (!result.value.changed) return writeJSON({ ok: true, duplicate: true })
  return writeJSON(result.value.reaction)
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
  const result = await removeReactionForActor(db, { messageId, userId, emoji })
  if (!result.ok) return writeError(result.error, result.status)

  return new Response(null, { status: 204 })
})
