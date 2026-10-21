"use client"

import type { ReactNode } from "react"
import { useSelectedLayoutSegments, usePathname } from "next/navigation"
import { useMeRouteMemory } from "@/hooks/community/use-me-route-memory"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"

export default function MeLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const segments = useSelectedLayoutSegments()
  const modulePlan = resolveCommunityModulePlan(segments.length ? `/c/me/${segments.join("/")}` : "/c/me")
  const dmId = modulePlan.main.kind === "dm" ? modulePlan.main.dmId : undefined
  useMeRouteMemory(pathname, !dmId)
  return children
}
