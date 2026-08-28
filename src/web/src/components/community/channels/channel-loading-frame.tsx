"use client"

import { MessageList } from "@/components/community/messages/message-list"
import { ComposerSkeleton } from "@/components/community/messages/composer"
import { ChannelHeaderSkeleton } from "./channel-header"

export function ChannelLoadingFrame() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading conversation"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ChannelHeaderSkeleton />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList channel="" messages={[]} loading onOpenThread={() => {}} />
        <ComposerSkeleton />
      </main>
      <span className="sr-only">Loading conversation</span>
    </div>
  )
}
