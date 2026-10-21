"use client"

import { useCommunityServerRoute } from "@/components/community/shell/community-route-context"
import { useEffect, useRef } from "react"
import { useCommunityModuleLocation } from "@/contexts/community/module-route"
import { CommunityPendingFrame } from "./community-pending-frame"
import { serverRootHref } from "@/lib/community/community-route"
import { useServer } from "@/hooks/community/use-servers"
import { useBreakpoint } from "@/hooks/use-mobile"
import { getLastChannel, resolveCommunityLandingHref } from "@/lib/community/last-channel"

export default function ServerDefaultPage() {
  const { serverId } = useCommunityServerRoute()
  const { router, searchParams } = useCommunityModuleLocation()
  const { server: currentServer } = useServer(serverId)
  const breakpoint = useBreakpoint()
  const replacingHrefRef = useRef<string | null>(null)

  useEffect(() => {
    if (breakpoint !== "desktop" || !currentServer) return
    const allChannels = currentServer.categories.flatMap((cat) => cat.channels)
    // Restore one remembered channel id, or use the first top-level channel
    // when there is no valid memory.
    const target = resolveCommunityLandingHref({
      serverId,
      channelIds: allChannels.filter((channel) => !channel.pending).map((channel) => channel.id),
      last: getLastChannel(serverId),
      breakpoint,
    })
    if (target !== `/c/channels/${encodeURIComponent(serverId)}`) {
      const search = searchParams.toString()
      const href = `${target}${search ? `?${search}` : ""}`
      if (replacingHrefRef.current === href) return
      replacingHrefRef.current = href
      router.replace(href)
    }
  }, [breakpoint, currentServer, serverId, router, searchParams])

  if (breakpoint !== "desktop") return null

  const allChannels = currentServer?.categories.flatMap((cat) => cat.channels) ?? []
  if (currentServer && allChannels.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-sm">No channels yet</span>
        <span className="text-xs">Create a channel from the sidebar to get started.</span>
      </div>
    )
  }

  const root = serverRootHref(serverId)
  const search = searchParams.toString()
  return <CommunityPendingFrame href={`${root}${search ? `?${search}` : ""}`} />
}
