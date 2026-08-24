"use client"

import { BotListSkeleton } from "@/components/community/bots/bot-list-view"
import { ChannelLoadingFrame } from "@/components/community/channels/channel-loading-frame"
import { MachineListSkeleton } from "@/components/community/machines/machine-list"
import { FriendsPage } from "@/components/community/social/friends-page"

export function CommunityPendingFrame({
  href,
  reserveBackSlot = false,
}: {
  href: string
  reserveBackSlot?: boolean
}) {
  const pathname = href.split(/[?#]/, 1)[0]
  if (pathname === "/c/me/machines") return <MachineListSkeleton reserveBackSlot={reserveBackSlot} />
  if (pathname === "/c/me/bots") return <BotListSkeleton reserveBackSlot={reserveBackSlot} />
  if (pathname === "/c/me/friends") {
    return (
      <FriendsPage
        friends={[]}
        pending={[]}
        blocked={[]}
        loading
        reserveBackSlot={reserveBackSlot}
      />
    )
  }
  return <ChannelLoadingFrame reserveBackSlot={reserveBackSlot} />
}
