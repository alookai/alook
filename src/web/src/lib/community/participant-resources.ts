import type { CommunityMemberRelation, CommunityResourceProfile, CommunityThreadsRead } from "@alook/shared"

export function resourceProfile(
  fields: Pick<CommunityResourceProfile, "id" | "name" | "discriminator" | "avatar" | "avatarVersion"> & Partial<CommunityResourceProfile>,
): CommunityResourceProfile {
  return { ...fields }
}

type Participant<Profile> = Pick<CommunityMemberRelation, "channelId" | "userId" | "isCreator"> & {
  profile: Profile
  participantCount?: number
}

export function threadParticipantResources<Profile extends Pick<CommunityResourceProfile, "id">>(rows: readonly Participant<Profile>[]): Pick<CommunityThreadsRead["included"], "members" | "participantCounts"> & { profiles: Profile[] } {
  const profiles = new Map<string, Profile>()
  const counts = new Map<string, number>()
  const authoritativeCounts = new Map<string, number>()
  const members = rows.map((row): CommunityMemberRelation => {
    profiles.set(row.userId, row.profile)
    counts.set(row.channelId, (counts.get(row.channelId) ?? 0) + 1)
    if (row.participantCount !== undefined) authoritativeCounts.set(row.channelId, row.participantCount)
    else authoritativeCounts.delete(row.channelId)
    return { channelId: row.channelId, userId: row.userId, isCreator: row.isCreator, relation: "notify", source: "explicit", role: null, memberId: null }
  })
  return { members, profiles: [...profiles.values()], participantCounts: [...counts].map(([channelId, count]) => ({ channelId, count: authoritativeCounts.get(channelId) ?? count })) }
}
