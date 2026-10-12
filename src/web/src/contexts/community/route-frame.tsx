"use client"

import { createContext, useContext, type RefObject } from "react"
import type { useRouter } from "next/navigation"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunityCommittedFrame } from "@/lib/community/community-route"
import type { OwnerServerDeleteRouteToken } from "@/lib/community/eject-server"

export type CommunityNavigationController = {
  captureIntent: (options?: { nextCommitHref: string }) => () => boolean
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
  push: ReturnType<typeof useRouter>["push"]
  pushImmediate: (href: string) => void
  replace: (href: string) => void
  resolveAndPush: (resolve: () => Promise<string>) => Promise<boolean>
  cancelPendingNavigation: () => void
}

export type NativeNotificationConversationConsumer = {
  matches: (viewerUserId: string, targetId: string) => boolean
  requestDismiss: () => void
}

export const CommunityRouteContext = createContext<{
  openInbox?: () => void
  notificationConsumer?: RefObject<NativeNotificationConversationConsumer | null>
  breakpoint: Breakpoint
  frame: CommunityCommittedFrame
  navigation: CommunityNavigationController
  ownerDeleteRouteScope: { serverId: string; token: OwnerServerDeleteRouteToken } | undefined
} | null>(null)

export function useCommunityRouteFrame() {
  const context = useContext(CommunityRouteContext)
  if (!context) throw new Error("Missing community route frame")
  return context
}

export const CommunityServerRouteContext = createContext<{
  serverId: string
  serverParam: string
} | null>(null)

export function useCommunityServerRoute() {
  const context = useContext(CommunityServerRouteContext)
  if (!context) throw new Error("Missing server content route")
  return context
}
