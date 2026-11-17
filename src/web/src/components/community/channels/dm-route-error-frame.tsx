"use client"

import { ConversationResolutionErrorFrame } from "./conversation-resolution-error-frame"
import { DmHeaderSkeleton } from "./dm-header"
import { ComposerSkeleton } from "@/components/community/messages/composer"

export function DmRouteErrorFrame({
  onRetry,
  retrying,
  reserveBackSlot = false,
}: {
  onRetry: () => void
  retrying: boolean
  reserveBackSlot?: boolean
}) {
  return (
    <>
      <DmHeaderSkeleton titleState="unavailable" onBack={reserveBackSlot ? () => {} : undefined} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConversationResolutionErrorFrame as="div" onRetry={onRetry} retrying={retrying} />
        <ComposerSkeleton />
      </main>
    </>
  )
}
