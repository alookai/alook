import type { MentionType } from "@alook/shared"
import type { ChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import type { MentionContext } from "@/lib/community/mention-extension"
import type { SendAttachment } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"

type ComposerMode = "chat" | "forumThreadBody"

export type ComposerReplyTarget = {
  authorName: string
  text: string
}

export type ComposerMention = {
  id: string
  label: string
}

export type MentionCandidateSource = {
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  failed: boolean
  searchQuery: string
  searchStatus:
    | "idle"
    | "loading"
    | "loading-more"
    | "ready"
    | "empty"
    | "error"
  loadMore: () => void
  search: (query: string) => void
}

export type ChannelRefCandidateSource = {
  loading: boolean
  failed: boolean
}

export type ComposerHandle = {
  focusEditor: () => void
  insertTextAtCaret: (text: string) => void
  insertMentionAtCaret: (mention: ComposerMention) => void
  submitNow: () => void
  resetAfterSubmit: () => void
  isEmpty: () => boolean
  openFilePicker: () => void
}

type ComposerBaseProps = {
  channel: string
  context: MentionContext
  members: Member[]
  mentionCandidates?: MentionCandidateSource
  channelRefCandidates?: ChannelRefCandidate[]
  channelRefCandidateSource?: ChannelRefCandidateSource
  onChannelRefIntent?: () => void
  onTyping?: () => void
  replyingTo?: ComposerReplyTarget
  onCancelReply?: () => void
  autoFocus?: boolean
  mode?: ComposerMode
  placeholder?: string
  hideEmoji?: boolean
  hideAttach?: boolean
  onDirty?: (hasContent: boolean) => void
  draftKey?: string
}

type ComposerAcceptedSend = {
  sendContract: "accepted"
  mode?: "chat"
  onAcceptSend: (
    markdown: string,
    attachments?: SendAttachment[],
    mentionType?: MentionType,
  ) => boolean
  onDeferredSubmit?: never
}

type ComposerDeferredSend = {
  sendContract: "deferred"
  mode: "forumThreadBody"
  onDeferredSubmit: (
    markdown: string,
    attachments?: SendAttachment[],
    mentionType?: MentionType,
  ) => void | Promise<void>
  onAcceptSend?: never
}

export type ComposerProps = ComposerBaseProps &
  (ComposerAcceptedSend | ComposerDeferredSend)
