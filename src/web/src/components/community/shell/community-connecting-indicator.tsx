"use client"

import { AlookLoading } from "@/components/brand/alook-loading/AlookLoading"

export function CommunityConnectingIndicator({ titleId }: { titleId?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      aria-live="polite"
      aria-atomic="true"
      className="community-ws-connecting-loader"
    >
      <div
        id={titleId}
        aria-hidden="true"
        data-connecting-motion=""
        className="flex h-36 w-44 items-center justify-center sm:h-40 sm:w-48"
      >
        <AlookLoading size={192} className="scale-90 sm:scale-100" />
      </div>
    </div>
  )
}
