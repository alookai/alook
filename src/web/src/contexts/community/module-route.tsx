"use client"

import { createContext, useContext, useMemo } from "react"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { useRouter, useSearchParams } from "next/navigation"

export const CommunityModuleRouteContext = createContext<{ href: string; routeCommitted: boolean } | null>(null)

export function useCommunityModuleLocation() {
  const target = useContext(CommunityModuleRouteContext)
  const publishedRouter = useRouter()
  const navigation = useContext(CommunityRouteContext)?.navigation
  const published = useSearchParams()
  const pendingNavigation = target && !target.routeCommitted ? navigation : undefined
  const push = pendingNavigation?.push ?? publishedRouter.push
  const replace = pendingNavigation?.replace ?? publishedRouter.replace
  const router = useMemo(() => ({ push, replace }), [push, replace])
  const search = target ? target.href.split("?")[1] ?? "" : published.toString()
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  return { router, searchParams, routeCommitted: target?.routeCommitted ?? true }
}
