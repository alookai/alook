import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { authorizeReaction } from "@/lib/community/reaction-access"
import { canonicalUserImage } from "@/lib/community/storage"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withCommunityActor(async (_req, ctx) => {
  if (ctx.actor.kind !== "human") return writeError("human session required", 401)
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)
  const access = await authorizeReaction(db, messageId, ctx.actor.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const actors = await queries.communityReaction.getReactionDetailsActors(
    db,
    messageId,
    access.scope,
  )
  return writeJSON({
    messageId,
    scope: access.scope,
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
            ) ?? avatarInitial(actor.profile.name),
            avatarVersion: actor.profile.avatarVersion,
          }
        : null,
    })),
  })
})
