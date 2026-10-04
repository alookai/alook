"use client"

import { useEffect, type ReactNode } from "react"
import { useParams, usePathname } from "next/navigation"
import { DmRoute } from "@/components/community/channels/dm-route"
import { useCurrentUser } from "@/contexts/community/current-user"
import { isRememberableMeLocation, setLastMeLocation } from "@/lib/community/last-me-location"
import { commitLastCommunityRoute } from "@/lib/community/last-community-route"

export default function MeLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const currentUser = useCurrentUser()
  const params = useParams<{ dmId?: string }>()
  useEffect(() => {
    const staticModuleActive = ["/c/me/friends", "/c/me/machines", "/c/me/bots"].includes(pathname)
    if (params.dmId || !staticModuleActive || !isRememberableMeLocation(pathname)) return
    setLastMeLocation(pathname)
    commitLastCommunityRoute(currentUser.id, pathname)
  }, [currentUser.id, params.dmId, pathname])
  return params.dmId
    ? <DmRoute key={`${currentUser.id}/${params.dmId}`} dmId={params.dmId} />
    : children
}
