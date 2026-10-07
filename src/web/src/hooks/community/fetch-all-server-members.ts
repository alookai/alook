import { InfiniteQueryObserver,type QueryClient,type InfiniteData } from "@tanstack/react-query"
import { MAX_MEMBERS_PAGE_SIZE,type CommunityRole } from "@alook/shared"
import type { Member } from "@/lib/community/models/people"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { serverMembershipKey } from "@/lib/community-db/schema"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { membersPageQueryFn,mergeMemberWindows,type MemberIdentity } from "./use-server-members"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"

function readServerMemberIdentities(queryClient: QueryClient, serverId: string, identities: readonly MemberIdentity[]): Member[] {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) throw new DOMException("Retired member owner", "AbortError")
  const seen = new Set<string>()
  return identities.flatMap((identity) => {
    if (seen.has(identity.id)) return []
    seen.add(identity.id)
    const row = registry.collections.serverMemberships.get(serverMembershipKey(serverId, identity.userId))
    if (!row || row.memberId !== identity.id) return []
    const canonical = registry.collections.profiles.get(identity.userId)
    const profile = readCommunityProfile(canonical ? { ...canonical, id: identity.userId } : undefined, identity.userId)
    const presence = registry.runtime.ws.get().presenceByUserId.get(identity.userId)
    return [{ id: identity.id, userId: identity.userId, name: row.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, role: row.role as CommunityRole, status: row.viewer ? "online" : presence ?? "offline", sub: "", statusEmoji: profile.statusEmoji, statusText: profile.statusText }]
  })
}

export async function fetchAllServerMembers(queryClient: QueryClient, serverId: string, signal?: AbortSignal): Promise<Member[]> {
  const original = captureCommunityLiveSnapshotToken(queryClient)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(queryClient, original, signal)
  assert()
  const key = [...communityKeys.members(serverId), "complete", MAX_MEMBERS_PAGE_SIZE] as const
  const options = {
    queryKey: key, queryFn: membersPageQueryFn(serverId, "", MAX_MEMBERS_PAGE_SIZE),
    initialPageParam: null as string | null | undefined,
    getNextPageParam: (last: Awaited<ReturnType<ReturnType<typeof membersPageQueryFn>>>) => last.hasMore ? last.cursor : undefined,
    staleTime: Infinity,
    structuralSharing: (previous: unknown, next: unknown) => mergeMemberWindows(queryClient, key, previous, next),
  }
  const observer = new InfiniteQueryObserver(queryClient, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  signal?.addEventListener("abort", unsubscribe, { once: true })
  try {
    let data: InfiniteData<Awaited<ReturnType<ReturnType<typeof membersPageQueryFn>>>> = await queryClient.infiniteQuery({ ...options, select: undefined })
    assert()
    while (observer.getCurrentResult().hasNextPage) {
      assert()
      const result = await observer.fetchNextPage({ cancelRefetch: false, throwOnError: true })
      assert()
      if (!result.data) throw new Error("Member pages could not be restored")
      data = result.data
    }
    assert()
    return readServerMemberIdentities(queryClient, serverId, data.pages.flatMap((page) => page.members))
  } finally { signal?.removeEventListener("abort", unsubscribe); unsubscribe() }
}
