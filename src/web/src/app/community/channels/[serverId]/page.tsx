"use client"

import { useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { useCommunity } from "@/contexts/community/context"
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
  const isAtMe = params.serverId === "@me"

  // Redirect to first channel when we have server data
  useEffect(() => {
    if (isAtMe) return
    if (!ctx.currentServer) return
    const allChannels = ctx.currentServer.categories.flatMap((cat) => cat.channels)
    const first = allChannels[0]
    if (first) {
      router.replace(`/community/channels/${params.serverId}/${first.id}`)
    }
  }, [isAtMe, ctx.currentServer, params.serverId, router])

  // @me view: Friends page
  if (isAtMe) {
    return (
      <FriendsPage
        friends={ctx.friends}
        pending={ctx.pending}
        blocked={ctx.blocked}
        onAccept={ctx.acceptFriendRequest}
        onReject={ctx.rejectFriendRequest}
        onCancelRequest={ctx.rejectFriendRequest}
        onUnblock={(id) => ctx.unblockUser(id)}
        onSendRequest={ctx.sendFriendRequest}
        onRemoveFriend={ctx.removeFriend}
        onBlock={(id) => ctx.blockUser(id)}
      />
    )
  }

  // Server view: show loading while we determine the first channel
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <span className="text-sm">Loading channels...</span>
    </div>
  )
}
