import { queries, withD1Retry, type Database } from "@alook/shared"
import { canonicalUserImage } from "./storage"
import { avatarInitial } from "./avatar"

export async function readCommunitySelfProfile(db: Database, userId: string) {
  const [profile, viewer] = await Promise.all([
    withD1Retry(() => queries.communityUserProfile.getProfile(db, userId), { route: "community/profile:self-profile" }),
    withD1Retry(() => queries.user.getUserSelf(db, userId), { route: "community/profile:self-user" }),
  ])
  const name = viewer?.name ?? ""
  return { viewer, profile: {
    id: userId, name,
    aboutMe: profile?.aboutMe ?? "",
    avatar: viewer ? canonicalUserImage(viewer.id, viewer.image, viewer.avatarVersion) ?? avatarInitial(name) : avatarInitial(name),
    avatarVersion: viewer?.avatarVersion ?? 0,
    bannerColor: profile?.bannerColor ?? null,
    discriminator: viewer?.discriminator ?? "0000",
    statusEmoji: profile?.statusEmoji ?? null,
    statusText: profile?.statusText ?? "",
  } }
}

export type CommunitySelfProfile = Awaited<ReturnType<typeof readCommunitySelfProfile>>["profile"]
