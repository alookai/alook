"use client"

import { createContext, useContext } from "react"
import type { CommunityCommittedFrame } from "@/lib/community/community-route"
import type { ShellFrameProps } from "./shell-frame-types"
import type { CommunityNavigationController } from "./use-community-navigation-controller"

export const CommunityRouteContext = createContext<{
  frame: CommunityCommittedFrame
  navigation: CommunityNavigationController
  ownerDeleteRouteScope: ShellFrameProps["ownerDeleteRouteScope"]
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
