/**
 * Shared view models for the community UI.
 *
 * These are render-ready shapes — denormalized and formatted for display, not raw DB
 * rows. The query layer produces them by joining the underlying tables (e.g. an author
 * id → name/avatar, reactions aggregated per message). Field names align with the
 * schema columns so the same components work for both mock and live data.
 *
 * Per-component `*Props` interfaces do NOT live here — they stay in each component
 * file. Only types shared across two or more components belong in this file.
 */

import type React from "react"
import type { ChannelType, CommunityRole } from "@alook/shared"

// ── Presence / enums ───────────────────────────────────────────────────────
export type Presence = "online" | "offline"

export type RightPanel = "members" | "pinned" | "search" | "threads" | null
export type MobileZone = "nav" | "messages"
export type View = "server" | "dm" | "settings"
export type SettingsSection =
  | "overview"
  | "members"
  | "invites"
  | "notifications"
  | "audit"

// ── Servers / rail ───────────────────────────────────────────────────────────
export type Server = {
  id: string // nanoid
  name: string
  initial: string
  active: boolean
  mentions: number
  isOwner?: boolean
  icon?: string | null
}

export type FolderServer = {
  id: string
  initial: string
  name: string
  icon?: string | null
}

export type CommunityFolder = {
  id: string
  name: string
  position: number
  servers: FolderServer[]
}

// ── Channels / categories ────────────────────────────────────────────────────
export type Channel = {
  id: string // nanoid
  name: string
  active: boolean
  unread: boolean
  muted?: boolean
  type?: ChannelType
  tags?: string[]
  creatorId?: string | null
}

export type Category = {
  id: string
  name: string
  channels: Channel[]
  private?: number | boolean
  creatorId?: string | null
}

// ── Messages ───────────────────────────────────────────────────────────────
export type Attachment =
  | { kind: "image"; name: string; url: string }
  | { kind: "file"; name: string; url: string; size: string }

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

type Reaction = { emoji: string; count: number; me: boolean; userIds: string[] }

export type Msg = {
  id: string // nanoid
  type?: "system"
  systemKind?: "join" | "thread"
  // Author's user id — populated by `mapMessageForApi` / WS message-create,
  // consumed by `useChannelWatermark` to skip self-authored messages when
  // advancing the read pointer. Optional to keep optimistic rows valid
  // before the server response reconciles.
  authorId?: string
  authorName?: string
  color?: string
  createdAt?: string // ISO 8601 timestamp — the UI formats for display
  authorAvatar?: string
  failed?: boolean
  content?: string
  embeds?: Embed[]
  attachments?: Attachment[]
  reactions?: Reaction[]
  replyTo?: { id: string; authorName: string; text: string; deleted?: boolean }
  thread?: { id: string; name: string; messageCount: number; participants?: string[]; lastReplyAt?: string }
  grouped?: boolean
}

// ── Threads / forum ──────────────────────────────────────────────────────────
// Thread/forum-post summaries shown in side panels and forum lists. Actual
// message content for a thread or post is loaded into `ctx.messages` once the
// user navigates into the child channel — these summaries don't carry messages.
export type Thread = {
  id: string // nanoid
  name: string
  messageCount: number
  lastMessageAt: string
  parent: { authorName: string; text: string }
  // The root message's per-channel seq, when the thread was created from a
  // parent message (omitted for threads with no parent, e.g. forum posts).
  // Used by `channel-ref-pill.tsx` to match a `/server/channel/#N` ref.
  parentSeq?: number
}

export type ForumPost = Thread & {
  authorAvatar: string
  tags: string[]
  preview: string
}

// ── Members / friends / DMs ──────────────────────────────────────────────────
export type Role = CommunityRole

export { canManageServer } from "@alook/shared"

export type Member = {
  id: string
  userId: string
  name: string
  // 4-digit discriminator (`"0042"`). Optional so mock/older payloads that
  // predate the column keep type-checking; live payloads always include it.
  discriminator?: string
  avatar: string
  status: Presence
  sub: string
  role: Role
}

export type Friend = {
  id: string
  userId?: string
  name: string
  // 4-digit discriminator (`"0042"`). Optional so mock/older payloads that
  // predate the column keep type-checking; live payloads always include it.
  discriminator?: string
  avatar: string
  status: Presence
  sub: string
}

export type PendingRequest = {
  id: string
  name: string
  avatar: string
  kind: "incoming" | "outgoing"
}

export type BlockedUser = { id: string; userId?: string; name: string; avatar: string }

// DM summary shown in the DM sidebar. Actual conversation history is loaded
// into `ctx.messages` once the user opens the DM — DM summaries don't carry
// inline messages.
export type DM = {
  id: string // nanoid
  userId: string
  name: string
  // 4-digit discriminator (`"0042"`). Optional for the same reason as Friend.
  discriminator?: string
  avatar: string
  status: Presence
  preview: string
  unread?: boolean
}

// ── Profile ──────────────────────────────────────────────────────────────────
export type Profile = {
  name: string
  // 4-digit discriminator hash of user.id (`"0042"`) — undefined while the
  // profile fetch is in flight. See computeDiscriminator in @alook/shared.
  discriminator?: string
  avatar: string
  role: string
  about: string
  mutual: number
  tags: string[]
}

// ── Settings rows ──────────────────────────────────────────────────────────
export type InviteRow = {
  code: string
  uses: number
  maxUses: number | null // null = unlimited
  expiresAt: string | null // ISO timestamp or null = never
  by: string
  creatorId: string | null
}


export type AuditEntry = {
  actor: string
  action: string
  target: string
  createdAt: string // ISO timestamp
}

// ── Mentions / inbox ─────────────────────────────────────────────────────────
export type Mention = {
  id: string
  server: string
  serverId?: string
  channel: string
  channelId?: string
  m: Msg
}

// "Unreads" — channels with unread messages, grouped by server.
export type UnreadServer = {
  serverId: string
  serverName: string
  channels: Array<{
    channelId: string
    channelName: string
    lastMessageAt: string
    mentionCount: number
  }>
}

// "Unreads" — DMs with unread messages, rendered as a flat sibling section
// under the same Unreads tab as channels.
export type UnreadDm = {
  dmConversationId: string
  otherUserId: string
  otherUserName: string
  otherUserAvatar: string
  lastMessageAt: string
}

// Shared callback signature for opening a user's profile card at a click point.
// `discriminator` is only ever passed for a mention pill that carried a
// disambiguating `#0042` tag (see message-markdown.tsx) — it lets the lookup
// pick the exact same-named member/friend instead of the first name match.
export type OpenProfile = (name: string, e: React.MouseEvent, discriminator?: string) => void
