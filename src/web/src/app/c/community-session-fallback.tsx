"use client"

import { usePathname } from "next/navigation"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"

export function CommunitySessionFallback() {
  const pathname = usePathname()
  return <CommunitySessionPendingFrame pathname={pathname} />
}
