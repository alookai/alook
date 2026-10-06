import { deriveView, viewEvidence } from "@/lib/observability/data-source"
import { avatarInitial } from "@/lib/community/avatar"
import type { CommunityProfile } from "@/lib/community/models/people"

export function readCommunityProfile(
  profile: CommunityProfile | undefined,
  userId: string,
) {
  const name = profile?.name ?? "Deleted user"
  return deriveView({
    id: userId,
    name,
    discriminator: profile?.discriminator ?? "",
    avatar: profile?.avatar ?? avatarInitial(name),
    avatarVersion: profile?.avatarVersion ?? 0,
    aboutMe: profile?.aboutMe ?? "",
    statusEmoji: profile?.statusEmoji,
    statusText: profile?.statusText,
    presence: profile?.presence ?? "offline" as const,
  }, [viewEvidence(profile)])
}
