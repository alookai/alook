import type { FriendApprovalPayload } from "@alook/shared"

// ── Messages ───────────────────────────────────────────────────────────────
type AttachmentMetadata = {
  name: string
  url: string
  contentType?: string
  sizeBytes?: number
}

export type FileAttachment = AttachmentMetadata & { kind: "file"; size: string }

export type Attachment =
  | (AttachmentMetadata & { kind: "image"; thumbnailUrl?: string; width?: number; height?: number })
  | FileAttachment

export type ImagePreview = {
  originalUrl: string
  thumbnailUrl?: string
  name: string
  width?: number
  height?: number
}

type Embed = {
  provider?: string
  url?: string
  title: string
  desc?: string
  color?: string
  image?: { url: string; width?: number; height?: number }
  thumbnail?: { url: string }
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string; iconUrl?: string }
  author?: { name: string; url?: string; iconUrl?: string }
}

export type Reaction = { emoji: string; count: number; me: boolean; userIds: string[] }

export type Msg = {
  id: string // nanoid
  // Exhaustive discriminator (#12 — was `type?: "system"`, an incomplete
  // partial discriminator that let `!m.type` silently misclassify a future
  // third kind as an ordinary chat message). `mapMessageForApi`/`mapMessageForWs`
  // always emit one of these two values now — never `undefined`.
  type: "chat" | "system"
  // Only ever set alongside `type: "system"` for a thread-creation system
  // message (see `message-payload.ts`'s `splitType`). The `"join"` value
  // that used to be part of this type is removed — no code path has ever
  // produced it (join notifications are pure WS events with no persisted
  // message row, and stay that way — see the debt-record's Out of scope).
  systemKind?: "thread"
  // Author's user id — populated by `mapMessageForApi` / WS message-create,
  // consumed by `useChannelWatermark` to skip self-authored messages when
  // advancing the read pointer. Optional to keep optimistic rows valid
  // before the server response reconciles.
  authorId?: string
  authorName?: string
  color?: string
  seq?: number // Per-scope (channel/DM) monotonic sequence number
  createdAt?: string // ISO 8601 timestamp — the UI formats for display
  authorAvatar?: string
  failed?: boolean
  // Idempotency nonce (mutation-idempotency plan). Stamped on optimistic rows
  // this client created and echoed back on the WS message-create, so a
  // 500-after-commit send that the user never retried self-heals: the WS row
  // reconciles the failed optimistic row by nonce instead of appearing twice.
  clientNonce?: string
  content?: string
  embeds?: Embed[]
  attachments?: Attachment[]
  reactions?: Reaction[]
  replyTo?: { id: string; authorName: string; text: string; deleted?: boolean }
  thread?: {
    id: string
    name: string
    messageCount: number
    lastReplyAt?: string
    tags?: string[]
    preview?: string
    participants?: { id: string; name: string; avatar: string }[]
    participantCount?: number
  }
  // Present only on a friend-approval DM card. Its presence (not the message
  // `type`) is the discriminator for rendering <BotApprovalCard>.
  approval?: FriendApprovalPayload
}

// `grouped` is a RENDER-TIME decision (computed by `message-list.tsx`'s
// cluster-building `useMemo`, based on adjacent messages' author/timestamp)
// — never a fact about a message itself, so it never belonged on `Msg`
// (#7). `<Message>` and any other consumer that needs the clustering
// decision takes a `RenderMsg`, not a bare `Msg` with `grouped` spread on.
export type RenderMsg = Msg & { grouped: boolean }

// ── Threads / forum ──────────────────────────────────────────────────────────
// Child-thread summaries shown in side panels and forum lists. Actual
// message content for a thread or post is loaded into `ctx.messages` once the
// user navigates into the child channel — these summaries don't carry messages.
export type Thread = {
  id: string // nanoid
  name: string
  messageCount: number
  lastMessageAt: string
  parent: { authorName: string; text: string }
  // The root message's per-channel seq, when the thread was created from a
  // parent message (omitted only for legacy rootless threads).
  // Used by `channel-ref-pill.tsx` to match a `/server/channel/#N` ref.
  parentSeq?: number
  // Stable opener identity used to reconcile forum-title edits without
  // accidentally patching a same-named or re-rooted child.
  openerMessageId?: string
}

export type ForumThread = Thread & {
  authorId: string
  authorAvatar: string
  openerMessageId: string
  tags: string[]
  preview: string
  // The post's participant (notify) set — creator first, then whoever
  // spoke/was mentioned/was added. Drives the card's AvatarGroup. Always
  // present (empty for a post with no participant rows yet, e.g. one created
  // before the notify-scope change shipped).
  participants: { id: string; name: string; avatar: string }[]
  // Total participant rows before the card-preview cap is applied.
  participantCount: number
}

export type SendAttachment = {
  file: File
  thumbnailBlob?: Blob
  previewObjectUrl?: string
  width?: number
  height?: number
}

export type MessagesPage = {
  messages: Msg[]
  latestSeq?: number
  // Anchor / since mode
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  olderCursor?: string
  newerCursor?: string
  // Legacy (newest + older continuation) mode
  hasMore?: boolean
  cursor?: string
}

// Discriminated pageParam. The queryFn dispatches on `mode` — the URL param
// map is: newest → no param, older → cursor, newer/since → since, anchor →
// anchor. Since also powers bounded reconnect catch-up without refetching
// every cached historical page.
export type MessagesPageParam =
  | { mode: "newest" }
  | { mode: "anchor"; anchor: string }
  | { mode: "since"; since: string }
  | { mode: "older"; cursor: string }
  | { mode: "newer"; cursor: string }
