import { ForumViewSkeleton } from "@/components/community/channels/forum-view"
import { ComposerSkeleton, MessageList } from "../messaging"
import { ChannelHeaderSkeleton } from "./channel-header"

export function ChannelScreenSkeleton({
  channelId = "",
  forum = false,
  onBack,
}: {
  channelId?: string
  forum?: boolean
  onBack?: () => void
}) {
  return (
    <>
      <ChannelHeaderSkeleton onBack={onBack} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {forum
          ? <ForumViewSkeleton />
          : <MessageList key={channelId} channel="" messages={[]} loading onOpenThread={() => {}} />}
        {!forum && <ComposerSkeleton />}
      </main>
    </>
  )
}
