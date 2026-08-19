"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { getLastMeLeaf, pickMeLandingLocation } from "@/lib/community/last-me-location"

export default function MeListPage() {
  const router = useRouter()
  const breakpoint = useBreakpoint()

  useEffect(() => {
    if (breakpoint !== "desktop") return
    router.replace(pickMeLandingLocation(getLastMeLeaf()))
  }, [breakpoint, router])

  return null
}
