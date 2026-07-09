import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const id = ctx.params?.userId
  if (!id) return writeError("missing user id", 400)

  const db = getDb(ctx.env.DB)

  // Get target user basic info
  const targetUser = await queries.user.getUserPublic(db, id)
  if (!targetUser) return writeError("user not found", 404)

  // Get profile data
  const profile = await queries.communityUserProfile.getProfile(db, id)

  // Find mutual servers (servers where both viewer and target are members)
  const viewerServerIds = await queries.communityMember.listMemberServerIds(db, ctx.userId)
  const targetServerIds = await queries.communityMember.listMemberServerIds(db, id)

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
  })
})
