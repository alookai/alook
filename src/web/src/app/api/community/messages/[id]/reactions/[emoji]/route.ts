import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  withD1Retry,
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

export const PUT = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  const rawEmoji = ctx.params?.emoji
  if (!messageId || !rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)
  if (Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    return writeError("emoji too long", 400)
  }

  const db = getDb(ctx.env.DB)
  const access = await authorizeReaction(db, messageId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  let reaction
  try {
    // `withD1Retry` (D1-armor state 3, idempotent write): a reaction is unique
    // per (messageId, userId, emoji), so a retry can't create a second. A
    // transient retries; the UNIQUE-constraint error is NOT in the retry
    // whitelist so withD1Retry rethrows it immediately into the catch below
    // (dup → { ok: true, duplicate: true }), unchanged.
    reaction = await withD1Retry(
      () =>
        queries.communityReaction.addReaction(db, {
          messageId,
          userId: ctx.userId,
          emoji,
        }),
      { route: "reactions/add" },
    )
  } catch (e) {
    if (isUniqueConstraintError(e)) return writeJSON({ ok: true, duplicate: true })
    throw e
  }

  const event = {
    type: WS_EVENTS.REACTION_ADD as typeof WS_EVENTS.REACTION_ADD,
    messageId,
    userId: ctx.userId,
    emoji,
    channelId: access.channelId,
  }

  if (access.isDm) {
    fanOutToDM(access.channelId, event, { excludeUserId: ctx.userId })
  } else {
    fanOutToChannel(access.channelId, event, { excludeUserId: ctx.userId })
  }

  return writeJSON(reaction)
})

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  const rawEmoji = ctx.params?.emoji
  if (!messageId || !rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)

  const db = getDb(ctx.env.DB)
  const access = await authorizeReaction(db, messageId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  // `withD1Retry` (D1-armor state 3): remove-by-key is idempotent (re-running
  // removes the same key / affects 0), safe to retry on a transient.
  await withD1Retry(
    () =>
      queries.communityReaction.removeReaction(db, {
        messageId,
        userId: ctx.userId,
        emoji,
      }),
    { route: "reactions/remove" },
  )

  const event = {
    type: WS_EVENTS.REACTION_REMOVE as typeof WS_EVENTS.REACTION_REMOVE,
    messageId,
    userId: ctx.userId,
    emoji,
    channelId: access.channelId,
  }

  if (access.isDm) {
    fanOutToDM(access.channelId, event, { excludeUserId: ctx.userId })
  } else {
    fanOutToChannel(access.channelId, event, { excludeUserId: ctx.userId })
  }

  return new Response(null, { status: 204 })
})
