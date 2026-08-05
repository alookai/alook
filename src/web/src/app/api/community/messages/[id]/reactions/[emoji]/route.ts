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
import { fanOutToChannel, fanOutToDM } from "@/lib/community/fanout"
import {
  requireChannelMember,
  requireDMAccess,
} from "@/lib/community/permissions"
import { requireReactableSurface } from "@/lib/community/channel-write-guard"

type AccessOk = { ok: true; channelId: string; isDm: boolean }
type AccessErr = { ok: false; status: 400 | 401 | 403 | 404; error: string }

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
export const PUT = withCommunityActor(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  const rawEmoji = ctx.params?.emoji
  if (!messageId || !rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)
  if (Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    return writeError("emoji too long", 400)
  }

  const userId = ctx.actor.userId
  const db = getDb(ctx.env.DB)
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
