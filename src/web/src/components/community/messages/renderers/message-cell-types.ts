import type { ReactNode } from "react"
import type { RenderMsg } from "@/lib/community/models/message"

export type MessageRendererId = "current"
export type MessageCellPresentationProps = {
  message: RenderMsg
  authorName: string
  timestamp: string
  viewerUserId?: string
  compact: boolean
  grouped: boolean
  selected: boolean
  highlighted: boolean
  slots: {
    avatar: ReactNode
    header: ReactNode
    reply: ReactNode
    content: ReactNode
    footer: ReactNode
    actions: ReactNode
    selection: ReactNode
  }
  onReply?: () => void
  onMentionAuthor?: () => void
  onCopy?: (selectedText?: string) => void
  onReact?: (emoji: string) => void
  onToggleReaction?: (emoji: string) => void
  onContentResize?: () => void
}
