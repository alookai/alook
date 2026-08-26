"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { getLastMeLeaf, pickMeLandingLocation } from "@/lib/community/last-me-location"

export default function MeListPage() {
  const router = useRouter()
  const breakpoint = useBreakpoint()
  const destination = breakpoint === "desktop"
    ? pickMeLandingLocation(getLastMeLeaf())
    : null

  useEffect(() => {
    if (!destination) return
    router.replace(destination)
  }, [destination, router])

  return destination ? <CommunityPendingFrame href={destination} /> : null
}
