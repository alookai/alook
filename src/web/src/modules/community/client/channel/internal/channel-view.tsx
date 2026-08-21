import type { ComponentProps } from "react"
import { ForumChannelSurface } from "@/components/community/channels/forum-channel-surface"
import { ThreadChannelSurface } from "@/components/community/channels/thread-channel-surface"
import { ChannelScreenSkeleton } from "../channel-screen-skeleton"
import { TextChannelController } from "./text-channel-controller"

export type ChannelViewProps = {
  channelId: string
  hydrated: boolean
  isForum: boolean
  isChildChannel: boolean
  onBack?: () => void
  thread: ComponentProps<typeof ThreadChannelSurface>
  forum: ComponentProps<typeof ForumChannelSurface>
  text: ComponentProps<typeof TextChannelController>
}

export function ChannelView({
  channelId,
  hydrated,
  isForum,
  isChildChannel,
  onBack,
  thread,
  forum,
  text,
}: ChannelViewProps) {
  if (!hydrated) {
    return <ChannelScreenSkeleton channelId={channelId} forum={isForum} onBack={onBack} />
  }
  if (isChildChannel) return <ThreadChannelSurface {...thread} />
  if (isForum) return <ForumChannelSurface {...forum} />
  return <TextChannelController {...text} />
}
