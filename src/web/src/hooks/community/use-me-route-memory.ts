"use client"

import { useEffect } from "react"
import { useCurrentUser } from "@/contexts/community/current-user"
import { isRememberableMeLocation, setLastMeLocation } from "@/lib/community/last-me-location"
import { commitLastCommunityRoute } from "@/lib/community/last-community-route"

export function useMeRouteMemory(pathname: string, active: boolean) {
  const currentUser = useCurrentUser()
  useEffect(() => {
    if (!active || !["/c/me/friends", "/c/me/machines", "/c/me/bots"].includes(pathname)
      || !isRememberableMeLocation(pathname)) return
    setLastMeLocation(pathname)
    commitLastCommunityRoute(currentUser.id, pathname)
  }, [active, currentUser.id, pathname])
}
