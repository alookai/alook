"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"
import { useCurrentUser } from "@/contexts/community/current-user"
import { resolveCommunityColdEntryDestination } from "@/lib/community/last-community-route"

export default function CommunityIndex() {
  const router = useRouter()
  const currentUser = useCurrentUser()
  useEffect(() => {
    const destination = resolveCommunityColdEntryDestination({
      accountId: currentUser.id,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    })
    router.replace(destination)
  }, [currentUser.id, router])
  return <CommunitySessionPendingFrame pathname="/c" />
}
