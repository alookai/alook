"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { DmView } from "./dm-view"
import { DmRouteErrorFrame } from "./dm-route-error-frame"
import { DmLoadingFrame } from "./dm-loading-frame"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { clearLastMeLocation, getLastMeLeaf, ME_ROOT } from "@/lib/community/last-me-location"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "@/lib/community/last-community-route"

export function DmRoute({ dmId }: { dmId: string }) {
  const runtime = useCommunityRuntime()
  const router = useRouter()
  const currentUser = useCurrentUser()
  const breakpoint = useBreakpoint()
  const verification = useChannelMetadata(null, dmId)
  const exitedTarget = useRef<string | null>(null)
  useEffect(() => {
    if (verification.status !== "denied" || verification.identityKnown) return
    const target = JSON.stringify([currentUser.id, dmId])
    if (exitedTarget.current === target) return
    exitedTarget.current = target
    const href = `/c/me/${encodeURIComponent(dmId)}`
    const destination = consumeCommunityColdEntryFailure(currentUser.id, href)
      ? COMMUNITY_COLD_ENTRY_FALLBACK
      : ME_ROOT
    if (getLastMeLeaf() === dmId) clearLastMeLocation()
    runtime.ui.get().uiHandlers.cancelPendingNavigation?.()
    router.replace(destination)
  }, [currentUser.id, dmId, router, runtime, verification.status, verification.identityKnown])

  if (verification.status === "retryable-error" && !verification.identityKnown) {
    return <DmRouteErrorFrame onRetry={verification.retry} retrying={verification.retrying}
      reserveBackSlot={breakpoint === "mobile"} />
  }
  if (!verification.identityKnown && verification.status !== "readable") {
    return <DmLoadingFrame reserveBackSlot={breakpoint === "mobile"} />
  }
  return <DmView dmId={dmId} />
}
