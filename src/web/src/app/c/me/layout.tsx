"use client"

import { useEffect, type ReactNode } from "react"
import { useSelectedLayoutSegments, usePathname } from "next/navigation"
import { DmRoute } from "@/components/community/channels/dm-route"
import { useCurrentUser } from "@/contexts/community/current-user"
import { isRememberableMeLocation, setLastMeLocation } from "@/lib/community/last-me-location"
import { commitLastCommunityRoute } from "@/lib/community/last-community-route"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"

export default function MeLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const currentUser = useCurrentUser()
  const segments = useSelectedLayoutSegments()
  const modulePlan = resolveCommunityModulePlan(segments.length ? `/c/me/${segments.join("/")}` : "/c/me")
  const dmId = modulePlan.main.kind === "dm" ? modulePlan.main.dmId : undefined
  useEffect(() => {
    const staticModuleActive = ["/c/me/friends", "/c/me/machines", "/c/me/bots"].includes(pathname)
    if (dmId || !staticModuleActive || !isRememberableMeLocation(pathname)) return
    setLastMeLocation(pathname)
    commitLastCommunityRoute(currentUser.id, pathname)
  }, [currentUser.id, dmId, pathname])
  return dmId
    ? <DmRoute key={`${currentUser.id}/${dmId}`} dmId={dmId} />
    : children
}
