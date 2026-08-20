import type { ReactNode } from "react"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"

export type MessageListProps = {
  channel: string
  messages: Msg[]
  loading?: boolean
  pinnedIds?: Set<string>
  newDividerBefore?: string
  typingUsers?: string[]
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onToggleReaction?: (id: string, emoji: string) => void
  onReact?: (id: string, emoji: string) => void
  onReply?: (id: string) => void
  onPin?: (id: string) => void
  onMark?: (id: string) => void
  onCreateThread?: (id: string) => void
  onCopy?: (id: string) => void
  onEdit?: (id: string) => void
  onRetry?: (id: string) => void
  onDismiss?: (id: string) => void
  onPreviewImage?: (image: ImagePreview) => void
  onPreviewAttachment?: (attachment: FileAttachment) => void
  onDownloadFile?: (url: string, name: string) => void
  resolveUserName?: (userId: string) => string
  scrollToMessageId?: string | null
  hero?: ReactNode
  variant?: "channel" | "dm"
  onScrollRoot?: (el: HTMLDivElement | null) => void
  viewerUserId?: string
  initialScrollReady?: boolean
  onScrollTargetConsumed?: (id: string) => void
  hasMore?: boolean
  isFetchingOlder?: boolean
  onLoadOlder?: () => void
  hasMoreNewer?: boolean
  isFetchingNewer?: boolean
  onLoadNewer?: () => void
  onJumpToPresent?: () => void
  presentVersion?: number
  unreadCount?: number
}

export type ResolvedMessageListProps = MessageListProps & {
  variant: "channel" | "dm"
  initialScrollReady: boolean
  hoverCapable: boolean
}
