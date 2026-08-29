import type { CommunityIdentityUpdate } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { projectIdentityPayload } from "@/lib/community/identity-projection"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { CommunityWsHandlerContext } from "@/hooks/community/community-ws/handler-context"

export function handleIdentityUpdate(
  event: CommunityIdentityUpdate,
  { queryClient, wsStore, projection }: CommunityWsHandlerContext,
) {
  const observed = wsStore.observeAvatarIdentity(
    event.userId,
    event.avatar,
    event.avatarVersion,
  )
  if (observed === "unbound" || observed === "stale" || observed === "same") return
  if (observed === "conflict") {
    projection.invalidate("identity-conflict", {
      queryKey: communityKeys.all,
      refetchType: "active",
    })
    return
  }

  let conflict = false
  projection.project(() => {
    queryClient.setQueriesData(
      { queryKey: communityKeys.all },
      (data) => projectIdentityPayload(data, () => { conflict = true }),
    )
    const current = useCommunityWsStore.getState().avatarIdentities.get(event.userId)
    if (current) {
      useMessageStreamStore.getState().projectAvatarIdentity(
        event.userId,
        current.avatar,
        current.avatarVersion,
      )
    }
  })
  if (conflict) {
    projection.invalidate("identity-cache-conflict", {
      queryKey: communityKeys.all,
      refetchType: "active",
    })
  }
}
