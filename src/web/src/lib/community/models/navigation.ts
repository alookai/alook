import type { ChannelType } from "@alook/shared"

export type EntityKind = "text" | "forum" | "thread"

// ── Servers / rail ───────────────────────────────────────────────────────────
export type Server = {
  id: string // nanoid
  name: string
  discriminator?: string
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
