import { Suspense } from "react"
import type { Metadata } from "next"
import { CommunityLayoutClient } from "./community-layout-client"
import { CommunityAccountPendingFrame } from "@/components/community/shell/community-account-pending-frame"

export const metadata: Metadata = { robots: { index: false, follow: false } }

export default function CommunityLayout() {
  return <div className="contents" data-community-shell="public">
    <Suspense fallback={<CommunityAccountPendingFrame pathname="/c" />}>
      <CommunityLayoutClient />
    </Suspense>
  </div>
}
