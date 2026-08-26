"use client"

import { BotListSkeleton } from "@/components/community/bots/bot-list-view"
import { ChannelLoadingFrame } from "@/components/community/channels/channel-loading-frame"
import { DmLoadingFrame } from "@/components/community/channels/dm-loading-frame"
import { MachineListSkeleton } from "@/components/community/machines/machine-list"
import { FriendsPage } from "@/components/community/social/friends-page"
import { Skeleton } from "@/components/ui/skeleton"

function MeRootPendingFrame() {
  return (
    <main aria-busy="true" aria-label="Loading your space" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-5/6" />
    </main>
  )
}

export function CommunityPendingFrame({
  href,
  reserveBackSlot = false,
}: {
  href: string
  reserveBackSlot?: boolean
}) {
  const pathname = href.split(/[?#]/, 1)[0]
  if (pathname === "/c/me") return <MeRootPendingFrame />
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
  if (/^\/c\/me\/[^/]+$/.test(pathname)) {
    return <DmLoadingFrame reserveBackSlot={reserveBackSlot} />
  }
  return <ChannelLoadingFrame reserveBackSlot={reserveBackSlot} />
}
