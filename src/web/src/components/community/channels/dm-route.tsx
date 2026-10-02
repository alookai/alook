"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { DmView } from "./dm-view"
import { DmRouteErrorFrame } from "./dm-route-error-frame"
import { DmLoadingFrame } from "./dm-loading-frame"
import { useDmRouteVerification } from "@/hooks/community/use-dm-route-verification"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useCommunityStore } from "@/stores/community"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { purgeCommunityChannel } from "@/lib/community-db/sync"
import { clearLastMeLocation, getLastMeLeaf, ME_ROOT } from "@/lib/community/last-me-location"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "@/lib/community/last-community-route"

export function DmRoute({ dmId }: { dmId: string }) {
  const router = useRouter()
  const currentUser = useCurrentUser()
  const breakpoint = useBreakpoint()
  const registry = useOptionalCommunityDbRegistry()
  const verification = useDmRouteVerification(dmId)
  useEffect(() => {
    if (verification.status !== "missing") return
    if (registry) purgeCommunityChannel(registry, dmId)
    if (getLastMeLeaf() === dmId) clearLastMeLocation()
    useCommunityStore.getState().uiHandlers.cancelPendingNavigation?.()
    const href = `/c/me/${encodeURIComponent(dmId)}`
    router.replace(consumeCommunityColdEntryFailure(currentUser.id, href)
      ? COMMUNITY_COLD_ENTRY_FALLBACK
      : ME_ROOT)
  }, [currentUser.id, dmId, registry, router, verification.status])

  if (verification.status === "error") {
    return <DmRouteErrorFrame onRetry={verification.retry} retrying={verification.retrying}
      reserveBackSlot={breakpoint === "mobile"} />
  }
  if (verification.status !== "present") {
    return <DmLoadingFrame reserveBackSlot={breakpoint === "mobile"} />
  }
  return <DmView dmId={dmId} />
}
