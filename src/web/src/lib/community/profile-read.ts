import { avatarInitial } from "@/lib/community/avatar"
import type { CommunityProfile } from "@/lib/community/models/people"

export function readCommunityProfile(
  profile: CommunityProfile | undefined,
  userId: string,
) {
  const name = profile?.name ?? "Unknown"
  return {
    id: userId,
    name,
    discriminator: profile?.discriminator ?? "",
    avatar: profile?.avatar ?? avatarInitial(name),
    avatarVersion: profile?.avatarVersion ?? 0,
    aboutMe: profile?.aboutMe ?? "",
    statusEmoji: profile?.statusEmoji,
    statusText: profile?.statusText,
    presence: profile?.presence ?? "offline" as const,
  }
}
