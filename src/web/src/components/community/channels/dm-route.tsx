"use client"

import { useEffect, useRef } from "react"
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
  const exitedTarget = useRef<string | null>(null)
  useEffect(() => {
    if (verification.status !== "missing") return
    const target = JSON.stringify([currentUser.id, dmId])
    if (exitedTarget.current === target) return
    exitedTarget.current = target
    const href = `/c/me/${encodeURIComponent(dmId)}`
    const destination = consumeCommunityColdEntryFailure(currentUser.id, href)
      ? COMMUNITY_COLD_ENTRY_FALLBACK
      : ME_ROOT
    if (registry) purgeCommunityChannel(registry, dmId)
    if (getLastMeLeaf() === dmId) clearLastMeLocation()
    useCommunityStore.getState().uiHandlers.cancelPendingNavigation?.()
    router.replace(destination)
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
