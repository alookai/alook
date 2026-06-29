"use client"

import { useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { FriendsPage } from "@/components/community/friends-page"

/**
 * /community/channels/:serverId
 *
 * - If serverId === "@me": render the Friends page (no DM selected)
 * - If server: redirect to the first channel by position
 */
export default function ServerDefaultPage() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  const ctx = useCommunity()
  const bp = useBreakpoint()
  const serverId = decodeURIComponent(params.serverId)
  const isAtMe = serverId === "@me"

  // Redirect to first channel when we have server data
  useEffect(() => {
    if (isAtMe) return
    if (!ctx.currentServer) return
    const allChannels = ctx.currentServer.categories.flatMap((cat) => cat.channels)
    const first = allChannels[0]
    if (first) {
      router.replace(`/community/channels/${serverId}/${first.id}`)
    }
  }, [isAtMe, ctx.currentServer, serverId, router])

  // @me view: Friends page
  if (isAtMe) {
    return (
      <FriendsPage
        friends={ctx.friends ?? []}
        pending={ctx.pending ?? []}
        blocked={ctx.blocked ?? []}
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
          if (dmId) router.push(`/community/channels/@me/${dmId}`)
        }}
      />
    )
  }

  // Server view: no channels yet or loading
  const allChannels = ctx.currentServer?.categories.flatMap((cat) => cat.channels) ?? []
  if (ctx.currentServer && allChannels.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-sm">No channels yet</span>
        <span className="text-xs">Create a channel from the sidebar to get started.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <span className="text-sm">Loading...</span>
    </div>
  )
}
