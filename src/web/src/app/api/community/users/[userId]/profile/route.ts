import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const id = ctx.params?.userId
  if (!id) return writeError("missing user id", 400)

  const db = getDb(ctx.env.DB)

  // Get target user basic info. `withD1Retry` (D1-armor: no-fallback profile
  // read) — retry a transient to the true value rather than 500; drives 404.
  const targetUser = await withD1Retry(() => queries.user.getUserPublic(db, id), {
    route: "users/profile/target",
  })
  if (!targetUser) return writeError("user not found", 404)

  // Profile + mutual-server reads, retried as one unit (all reads, no side
  // effects) so a transient blip doesn't 500 a profile view.
  const { profile, viewerServerIds, targetServerIds } = await withD1Retry(
    async () => ({
      profile: await queries.communityUserProfile.getProfile(db, id),
      viewerServerIds: await queries.communityMember.listMemberServerIds(db, ctx.userId),
      targetServerIds: await queries.communityMember.listMemberServerIds(db, id),
    }),
    { route: "users/profile" },
  )

  const viewerSet = new Set(viewerServerIds)
  const mutualServers = targetServerIds.filter((sid) => viewerSet.has(sid)).length

  return writeJSON({
    id: targetUser.id,
    name: targetUser.name,
    discriminator: targetUser.discriminator,
    image: targetUser.image,
    aboutMe: profile?.aboutMe ?? "",
    bannerColor: profile?.bannerColor ?? null,
    mutualServers,
    statusEmoji: profile?.statusEmoji ?? null,
    statusText: profile?.statusText ?? "",
  })
})
