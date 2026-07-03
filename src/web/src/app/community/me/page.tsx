"use client"

import { useRouter } from "next/navigation"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/hooks/use-mobile"
import { FriendsPage } from "@/components/community/friends-page"

export default function MeFriendsPage() {
  const router = useRouter()
  const ctx = useCommunity()
  const bp = useBreakpoint()
  return (
    <FriendsPage
      friends={ctx.friends ?? []}
      pending={ctx.pending ?? []}
      blocked={ctx.blocked ?? []}
      loading={ctx.friendsLoading}
      onBack={bp === "mobile" ? () => ctx.goBackMobile() : undefined}
      onAccept={ctx.acceptFriendRequest}
      onReject={ctx.rejectFriendRequest}
      onCancelRequest={ctx.rejectFriendRequest}
      onUnblock={(id) => ctx.unblockUser(id)}
      onSendRequest={ctx.sendFriendRequest}
      onRemoveFriend={ctx.removeFriend}
      onBlock={(id) => ctx.blockUser(id)}
      onDm={async (userId) => {
        const dmId = await ctx.createOrGetDm(userId)
        if (dmId) router.push(`/community/me/${dmId}`)
      }}
    />
  )
}
