import type { CommunityMemberRelation, CommunityResourceProfile, CommunityThreadsRead } from "@alook/shared"

export function resourceProfile(
  fields: Pick<CommunityResourceProfile, "id" | "name" | "avatar" | "avatarVersion"> & Partial<CommunityResourceProfile>,
): CommunityResourceProfile {
  return { discriminator: null, statusEmoji: null, statusText: "", ...fields }
}

type Participant = Pick<CommunityMemberRelation, "channelId" | "userId" | "isCreator"> & {
  profile: CommunityResourceProfile
  participantCount?: number
}

export function threadParticipantResources(rows: readonly Participant[]): Pick<CommunityThreadsRead["included"], "members" | "profiles" | "participantCounts"> {
  const profiles = new Map<string, CommunityResourceProfile>()
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
