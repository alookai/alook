import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { parseCommunityReactionDetailsRead, queries } from "@alook/shared"
import { authorizeReaction } from "@/lib/community/reaction-access"
import { parseBoundedInt } from "@/lib/community/messages"
import { canonicalUserImage } from "@/lib/community/storage"

const DEFAULT_REACTION_DETAILS_LIMIT = 100
const MAX_REACTION_DETAILS_LIMIT = 200

function validateReactionDetailsCursor(raw: string | null, emoji: string | undefined): string | undefined | null {
  if (!raw) return undefined
  if (emoji !== undefined) {
    const separator = raw.indexOf("|")
    if (separator <= 0 || separator === raw.length - 1 || raw.indexOf("|", separator + 1) !== -1) {
      return null
    }
  }
  return raw
}

export const GET = withAuth(communityActorPolicy(), async (req, ctx) => {
  if (ctx.actor.kind !== "human") return writeError("human session required", 401)
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const searchParams = req.nextUrl.searchParams
  const rawEmoji = searchParams.get("emoji")
  const emoji = rawEmoji?.trim() || undefined
  if (rawEmoji !== null && !emoji) return writeError("invalid emoji", 400)
  const rawLimit = searchParams.get("limit")
  const rawCursor = searchParams.get("cursor")
  const cursor = validateReactionDetailsCursor(rawCursor, emoji)
  if (cursor === null) return writeError("invalid cursor", 400)

  const db = getDb(ctx.env.DB)
  const access = await authorizeReaction(db, messageId, ctx.actor.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const paginatedRequest = emoji !== undefined || rawLimit !== null || cursor !== undefined
  const limit = parseBoundedInt(rawLimit, DEFAULT_REACTION_DETAILS_LIMIT, MAX_REACTION_DETAILS_LIMIT)

  let actors: Awaited<ReturnType<typeof queries.communityReaction.getReactionDetailsActors>>
  let hasMore: boolean | undefined
  let nextCursor: string | undefined

  if (paginatedRequest && typeof queries.communityReaction.getReactionDetailsActorsPage === "function") {
    const page = await queries.communityReaction.getReactionDetailsActorsPage(
      db,
      messageId,
      access.scope,
      { emoji, limit, cursor },
    )
    actors = page.actors
    hasMore = page.hasMore
    nextCursor = page.cursor ?? undefined
  } else {
    actors = await queries.communityReaction.getReactionDetailsActors(
      db,
      messageId,
      access.scope,
    )
  }

  return writeJSON(parseCommunityReactionDetailsRead({
    messageId,
    scope: access.scope,
    ...(emoji !== undefined ? { emoji } : {}),
    actors: actors.map((actor) => ({
      userId: actor.userId,
      profile: actor.profile
        ? {
            id: actor.profile.id,
            name: actor.profile.name,
            discriminator: actor.profile.discriminator,
            avatar: canonicalUserImage(
              actor.profile.id,
              actor.profile.image,
              actor.profile.avatarVersion,
            ),
            avatarVersion: actor.profile.avatarVersion,
          }
        : null,
    })),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
  }, messageId, access.scope))
})
