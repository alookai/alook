"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import { getLastMeLeaf, pickMeLandingLocation } from "@/lib/community/last-me-location"
import { useSelector } from "@tanstack/react-store"
import { useQueryClient } from "@tanstack/react-query"
import { getCommunityRuntime } from "@/stores/community/runtime"

export default function MeListPage() {
  const router = useRouter()
  const breakpoint = useBreakpoint()
  const onboarding = useCommunityOnboarding()
  const queryClient = useQueryClient()
  const runtime = getCommunityRuntime(queryClient)
  const ownerDeleteRootLanding = useSelector(runtime.serverEject, (state) => state.meRootLanding)
  const destination = breakpoint === "desktop"
    && !onboarding
    && !ownerDeleteRootLanding
    ? pickMeLandingLocation(getLastMeLeaf())
    : null

  useEffect(() => {
    if (!destination) return
    if (runtime.ui.get().onboardingState || runtime.serverEject.get().meRootLanding) return
    router.replace(destination)
  }, [destination, router, runtime])

  return destination ? <CommunityPendingFrame href={destination} /> : null
}
