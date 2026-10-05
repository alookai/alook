"use client"

import { useCallback, useLayoutEffect, useMemo, type ReactNode } from "react"
import { useSelectedLayoutSegments } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useCurrentUser } from "@/contexts/community/current-user"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { communityServerId } from "@/lib/community/community-route"
import { createOwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import { ShellFrame } from "./shell-frame"

export function CommunityRouteFrame({ sidebar, children }: {
  sidebar: ReactNode
  children: ReactNode
}) {
  const segments = useSelectedLayoutSegments()
  const frameHref = segments.length ? `/c/${segments.join("/")}` : "/c"
  const serverId = communityServerId(frameHref)
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const ownerDeleteRouteScope = useMemo(() => serverId ? {
    serverId,
    token: createOwnerServerDeleteRouteToken(queryClient),
  } : undefined, [queryClient, serverId])
  const renderSidebar = useCallback(() => sidebar, [sidebar])

  useLayoutEffect(() => {
    getCommunityRuntime(queryClient).ui.actions.setCurrentServerId(serverId)
  }, [queryClient, serverId])

  return (
    <ShellFrame
      key={currentUser.id}
      view={serverId ? "server" : "dm"}
      activeServerId={serverId ?? undefined}
      frameHref={frameHref}
      sidebar={renderSidebar}
      ownerDeleteRouteScope={ownerDeleteRouteScope}
    >
      {children}
    </ShellFrame>
  )
}
