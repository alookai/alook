import { CommunityResourceProfileSchema, queries, withD1Retry, type Database } from "@alook/shared"
import { canonicalUserImage } from "./storage"

export async function readCommunitySelfProfile(db: Database, userId: string) {
  const [profile, viewer] = await Promise.all([
    withD1Retry(() => queries.communityUserProfile.getProfile(db, userId), { route: "community/profile:self-profile" }),
    withD1Retry(() => queries.user.getUserSelf(db, userId), { route: "community/profile:self-user" }),
  ])
  if (!viewer) return null
  return { viewer, profile: CommunityResourceProfileSchema.parse({
    id: viewer.id, name: viewer.name, aboutMe: profile?.aboutMe ?? "",
    avatar: canonicalUserImage(viewer.id, viewer.image, viewer.avatarVersion), avatarVersion: viewer.avatarVersion,
    bannerColor: profile?.bannerColor ?? null, discriminator: viewer.discriminator,
    statusEmoji: profile?.statusEmoji ?? null, statusText: profile?.statusText ?? null,
  }) }
}
