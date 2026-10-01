"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { ServerLandingPendingFrame } from "@/components/community/shell/server-landing-pending-frame"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { useServer } from "@/hooks/community/use-servers"
import { useBreakpoint } from "@/hooks/use-mobile"
import { getLastChannel, pickServerLandingChannel } from "@/lib/community/last-channel"
import { useOptionalCommunityDbRegistry, useRouteChannelProjection } from "@/lib/community-db/projections"

export default function ServerDefaultPage() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(params.serverId)
  const { server: currentServer } = useServer(serverId)
  const breakpoint = useBreakpoint()
  const replacingHrefRef = useRef<string | null>(null)
  const allChannels = currentServer?.categories.flatMap((cat) => cat.channels) ?? []
  const registry = useOptionalCommunityDbRegistry()
  const pendingTarget = useSyncExternalStore(registry?.subscribePendingRouteTypes ?? (() => () => {}),
    () => registry?.getPendingLandingChannel(serverId, getLastChannel(serverId)), () => undefined)
  const target = currentServer ? pickServerLandingChannel(
    allChannels.map((channel) => channel.id),
    getLastChannel(serverId),
  ) : pendingTarget?.id
  const targetChannel = useRouteChannelProjection(target ?? null)
  const cachedType = targetChannel?.serverId === serverId
    ? targetChannel.type
    : allChannels.find((channel) => channel.id === target)?.type
  const conversationSubtype = cachedType === "text" || cachedType === "forum" || cachedType === "thread"
    ? cachedType : undefined
  const search = searchParams.toString()
  const targetHref = target ? `/c/channels/${serverId}/${target}${search ? `?${search}` : ""}` : null

  useEffect(() => {
    if (breakpoint !== "desktop" || !currentServer || !targetHref) return
    if (replacingHrefRef.current === targetHref) return
    replacingHrefRef.current = targetHref
    router.replace(targetHref)
  }, [breakpoint, currentServer, targetHref, router])

  if (breakpoint !== "desktop") return null

  if (currentServer && allChannels.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-sm">No channels yet</span>
        <span className="text-xs">Create a channel from the sidebar to get started.</span>
      </div>
    )
  }

  return targetHref && conversationSubtype
    ? <CommunityPendingFrame href={targetHref} conversationSubtype={conversationSubtype} />
    : <ServerLandingPendingFrame />
}
