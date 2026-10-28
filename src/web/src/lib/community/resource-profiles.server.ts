import { CommunityResourceProfileSchema, queries, type Database } from "@alook/shared"
import { canonicalUserImage } from "./storage"

export async function readCommunityResourceProfiles(db: Database, userIds: readonly string[]) {
  const ids = [...new Set(userIds)]
  if (!ids.length) return []
  const users = await queries.user.getUsersByIds(db, ids)
  const profileRows = await queries.communityUserProfile.getProfilesByUserIds(db, users.map(row => row.id))
  const profiles = new Map(profileRows.map(row => [row.userId, row]))
  return users.map(row => CommunityResourceProfileSchema.parse({
    id: row.id, name: row.name, discriminator: row.discriminator,
    ...(profiles.has(row.id) ? { aboutMe: profiles.get(row.id)!.aboutMe, bannerColor: profiles.get(row.id)!.bannerColor, statusEmoji: profiles.get(row.id)!.statusEmoji, statusText: profiles.get(row.id)!.statusText } : {}),
    avatar: canonicalUserImage(row.id, row.image, row.avatarVersion), avatarVersion: row.avatarVersion,
  }))
}
