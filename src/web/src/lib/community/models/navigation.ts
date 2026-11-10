import type { ChannelType, CommunityRole, ServerRailEntry } from "@alook/shared"

export type EntityKind = "text" | "forum" | "thread"

// ── Servers / rail ───────────────────────────────────────────────────────────
export type Server = {
  id: string // nanoid
  name: string
  discriminator?: string
  description?: string
  ownerId?: string
  initial: string
  active: boolean
  unread: boolean
  mentions: number
  /** Exact human unread sources. Absent only for rolling-deploy cache rows. */
  unreadSources?: Array<{ channelId: string; lastUnreadSeq: number }>
  /** Exact direct-mention sources behind the numeric rail badge. */
  mentionSources?: Array<{ channelId: string; count: number; lastSeq: number }>
  official?: boolean
  isOwner?: boolean
  role?: CommunityRole
  memberId?: string
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
  servers: FolderServer[]
}

// ── Channels / categories ────────────────────────────────────────────────────
export type Channel = {
  id: string // nanoid
  name: string
  active: boolean
  unread: boolean
  muted?: boolean
  unarchivedPostCount?: number
  type?: ChannelType
  tags?: string[]
  creatorId?: string | null
  // Optimistic placeholder row — non-interactive until the create resolves.
  pending?: boolean
}

export type Category = {
  id: string
  name: string
  channels: Channel[]
  private?: number | boolean
  creatorId?: string | null
  // Optimistic placeholder category — reconciled when the create resolves.
  pending?: boolean
}

export type ServersResponse = { servers: Server[] }
export type FoldersResponse = { folders: CommunityFolder[]; topOrder?: ServerRailEntry[] | null }

export type ServerDetail = {
  id: string
  name: string
  discriminator: string
  description: string
  icon: string | null
  official?: boolean
  ownerId: string
  categories: Category[]
  /** Canonical unread ownership for participating children of forum channels. */
  forumUnreadState?: ForumUnreadState
  unreadSources?: Array<{
    channelId: string
    lastUnreadSeq: number
    lastAttentionSeq: number | null
  }>
}

type ForumUnreadState = Record<string, {
  /** The forum channel's own unread contribution, excluding child posts. */
  baseUnread: boolean
  /** Every canonically unread participating child, loaded in the sidebar or not. */
  childIds: string[]
}>
