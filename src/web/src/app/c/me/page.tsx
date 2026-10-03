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
  const ownerDeleteRootLanding = useSelector(getCommunityRuntime(queryClient).serverEject, (state) => state.meRootLanding)
  const destination = breakpoint === "desktop"
    && !onboarding
    && !ownerDeleteRootLanding
    ? pickMeLandingLocation(getLastMeLeaf())
    : null

  useEffect(() => {
    if (!destination) return
    router.replace(destination)
  }, [destination, router])

  return destination ? <CommunityPendingFrame href={destination} /> : null
}
