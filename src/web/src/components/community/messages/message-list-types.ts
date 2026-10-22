import type { ReactNode } from "react"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { MessagePositionState, MessageRequest } from "@/lib/community/message-position"

export type MessageListProps = {
  observation?: import("@/lib/observability/regions").ResourceObservation
  channel: string
  messages: Msg[]
  loading?: boolean
  initialLoadError?: Error | null
  retryingInitialLoad?: boolean
  onRetryInitialLoad?: () => void
  pinnedIds?: Set<string>
  newDividerBefore?: string
  typingUsers?: string[]
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onToggleReaction?: (id: string, emoji: string) => void
  onReact?: (id: string, emoji: string) => void
  onReply?: (id: string) => void
  resolveAuthorMentionText?: (authorId: string) => string | null
  onInsertMentionText?: (text: string) => void
  onPin?: (id: string) => void
  onMark?: (id: string) => void
  onCreateThread?: (id: string) => void
  onCopy?: (id: string) => void
  onEdit?: (id: string) => void
  onRetry?: (id: string) => void
  onDismiss?: (id: string) => void
  onPreviewImage?: (image: ImagePreview) => void
  onPreviewAttachment?: (attachment: FileAttachment) => void
  resolveUserName?: (userId: string) => string
  scrollToMessageId?: string | null
  initialPositionMessageId?: string | null
  positionEntry?: object | null
  positionDataState?: MessagePositionState
  messageWindow?: object
  active?: boolean
  hero?: ReactNode
  variant?: "channel" | "dm"
  onScrollRoot?: (el: HTMLDivElement | null) => void
  viewerUserId?: string
  initialScrollReady?: boolean
  onScrollTargetConsumed?: (id: string) => void
  hasMore?: boolean
  historyStartKnown?: boolean
  isFetching?: boolean
  isFetchingOlder?: boolean
  onLoadOlder?: () => MessageRequest | void
  hasMoreNewer?: boolean
  isFetchingNewer?: boolean
  onLoadNewer?: () => MessageRequest | void
  onJumpToPresent?: () => MessageRequest | void
  presentVersion?: number
  presentRequest?: MessageRequest | null
  localSubmitVersion?: number
  unreadCount?: number
}

export type ResolvedMessageListProps = MessageListProps & {
  variant: "channel" | "dm"
  initialScrollReady: boolean
  hoverCapable: boolean
}
