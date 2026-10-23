"use client"

import { createContext, useContext, useMemo } from "react"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { useSearchParams } from "next/navigation"
import { useCommunityHistoryRouter as useRouter } from "@/lib/community/navigation"

export const CommunityModuleRouteContext = createContext<{ href: string; routeCommitted: boolean } | null>(null)

export function useCommunityRouter() {
  const publishedRouter = useRouter()
  const navigation = useContext(CommunityRouteContext)?.navigation
  const push = navigation?.push ?? publishedRouter.push
  const replace = navigation?.replace ?? publishedRouter.replace
  return useMemo(() => ({ push, replace }), [push, replace])
}

export function useCommunityModuleLocation() {
  const target = useContext(CommunityModuleRouteContext)
  const router = useCommunityRouter()
  const published = useSearchParams()
  const search = target ? target.href.split("?")[1] ?? "" : published.toString()
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  return { router, searchParams, routeCommitted: target?.routeCommitted ?? true }
}
