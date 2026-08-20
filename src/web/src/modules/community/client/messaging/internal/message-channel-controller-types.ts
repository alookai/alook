import type { ReactNode } from "react"
import type { MentionType } from "@alook/shared"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import type { SendAttachment } from "../composer"
import type { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

type MessageFeed = ReturnType<typeof useChannelMessageFeed>

export type Viewer = {
  id: string
  name: string
  avatar: string
}

export type MessageUiHandlers = {
  navigate?: (serverId: string, channelId: string) => void
  previewImage?: (image: ImagePreview) => void
  previewAttachment?: (attachment: FileAttachment) => void
}

export type ReplyTarget = {
  id: string
  authorName: string
  text: string
}

export type MessageContextTarget = {
  serverId: string
  channelId: string
  label: string
  seq: number
}

export type MessageActions = {
  onToggleReaction: (id: string, emoji: string) => void
  onReact: (id: string, emoji: string) => void
  onReply: (id: string) => void
  onPin: (id: string) => void
  onMark: (id: string) => void
  onCreateThread: (id: string) => Promise<void>
  onCopy: (id: string) => void
  onEdit: (id: string) => void
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
  onPreviewImage: (image: ImagePreview) => void
  onPreviewAttachment: (attachment: FileAttachment) => void
  onDownloadFile: (url: string, name: string) => void
}

export type MessageChannelControllerValue = {
  feed: MessageFeed
  pinnedIds: Set<string>
  replyTo: ReplyTarget | null
  setReplyTo: (reply: ReplyTarget | null) => void
  searchQuery: string
  searchResults: Msg[]
  search: (query: string) => void
  scrollTargetId: string | null
  setScrollTargetId: (targetId: string | null) => void
  consumeScrollTarget: (targetId: string) => void
  contextTarget: MessageContextTarget | null
  setContextTarget: (target: MessageContextTarget | null) => void
  openContextSeq: (seq: number) => void
  onSheetReply: (target: ReplyTarget) => void
  jumpToSeq: (seq: number) => void
  messageActions: MessageActions
  threadActions: Omit<MessageActions, "onCreateThread"> & { onCreateThread: undefined }
  acceptMessage: (
    markdown: string,
    attachments?: SendAttachment[],
    mentionType?: MentionType,
  ) => boolean
  handleTyping: () => void
  typingUsers: string[]
}

export type MessageChannelControllerProps = {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  forumParentChannelId?: string
  viewer: Viewer
  anchorMessageId: string | null
  feed: MessageFeed
  uiHandlers: MessageUiHandlers
  onOpenThread: (threadId: string) => void
  onOpenPinned: () => void
  resolveUserName: (userId: string) => string
  children: (controller: MessageChannelControllerValue) => ReactNode
}
