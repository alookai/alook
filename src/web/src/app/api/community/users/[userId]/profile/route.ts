import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { canonicalUserImage } from "@/lib/community/storage"

export const GET = withAuth(async (_req, ctx) => {
  const id = ctx.params?.userId
  if (!id) return writeError("missing user id", 400)

  const db = getDb(ctx.env.DB)

  const profile = await queries.communityUserProfile.getPublicProfileForViewer(
    db,
    id,
    ctx.userId,
  )
  if (!profile) return writeError("user not found", 404)

  // Find mutual servers (servers where both viewer and target are members)
  const [viewerServerIds, targetServerIds] = await Promise.all([
    queries.communityMember.listMemberServerIds(db, ctx.userId),
    queries.communityMember.listMemberServerIds(db, id),
  ])

  const viewerSet = new Set(viewerServerIds)
  const mutualServers = targetServerIds.filter((sid) => viewerSet.has(sid)).length

  return writeJSON({
    id: profile.id,
    name: profile.name,
    discriminator: profile.discriminator,
    image: canonicalUserImage(profile.id, profile.image, profile.avatarVersion),
    avatarVersion: profile.avatarVersion,
    aboutMe: profile.aboutMe,
    bannerColor: profile.bannerColor,
    mutualServers,
    statusEmoji: profile.statusEmoji,
    statusText: profile.statusText,
    ...profile.identity,
  })
})
