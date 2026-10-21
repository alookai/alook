"use client"

import { CommunityModuleRouteContext, useCommunityRouter } from "@/contexts/community/module-route"
import { useContext, useEffect } from "react"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { useCurrentUser } from "@/contexts/community/current-user"
import { resolveCommunityColdEntryDestination } from "@/lib/community/last-community-route"

export default function CommunityIndex() {
  const router = useCommunityRouter()
  const currentUser = useCurrentUser()
  const target = useContext(CommunityModuleRouteContext)
  const targetHref = target?.href
  useEffect(() => {
    const entry = targetHref ? new URL(targetHref, window.location.origin) : window.location
    const destination = resolveCommunityColdEntryDestination({
      accountId: currentUser.id,
      pathname: entry.pathname,
      search: entry.search,
      hash: entry.hash,
    })
    router.replace(destination)
  }, [currentUser.id, router, targetHref])
  return <CommunityPendingFrame href="/c" />
}
