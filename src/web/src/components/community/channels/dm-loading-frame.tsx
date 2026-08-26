"use client"

import { DmHeaderSkeleton } from "./dm-header"
import { MessageList } from "@/components/community/messages/message-list"
import { ComposerSkeleton } from "@/components/community/messages/composer"

export function DmLoadingFrame({ reserveBackSlot = false }: { reserveBackSlot?: boolean }) {
  return (
    <>
      <DmHeaderSkeleton onBack={reserveBackSlot ? () => {} : undefined} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-busy="true" aria-label="Loading direct message">
        <MessageList channel="" messages={[]} loading onOpenThread={() => {}} variant="dm" />
        <ComposerSkeleton />
      </main>
    </>
  )
}
