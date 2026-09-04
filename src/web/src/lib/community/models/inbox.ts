import type { MentionKind } from "@alook/shared"
import type { EntityKind } from "./navigation"
import type { Msg } from "./message"

// ── Mentions / inbox ─────────────────────────────────────────────────────────
export type Mention = {
  id: string
  // "mention" (@-mention) vs "reply" (reply to your message). Drives the row
  // label ("mentioned you" vs "replied to you"). Optional for back-compat with
  // any cached payload written before the field existed.
  kind?: MentionKind
  server: string
  serverId?: string
  channel: string
  channelId?: string
  m: Msg
}

// A single per-user saved ("marked") message, as returned by
// `/api/community/users/me/marks`. Cross-channel newest-first — each row carries
// the serverId + channelId + seq needed to deep-link back to the message
// (unlike a Mention, which only opens the channel, a Marked row jumps to the
// exact message via the `?msg=<id>` deep-link). `id` is the mark row's own id,
// used to unmark from the list.
export type Marked = {
  id: string // the mark row id (for DELETE / list removal)
  // A DM has no server: `serverId` is null and `server` may be the peer's name
  // or empty. The null serverId is the discriminator the jump uses — server
  // rows deep-link via `?msg=`, DM rows navigate to `/c/me/<channelId>` and
  // open the context sheet.
  server: string
  serverId: string | null
  channel: string
  // For a server message this is the channel id; for a DM it's the DM channel
  // id, which is also the frontend `/c/me/<id>` route param.
  channelId: string
  // Legacy cached payloads may include the parent for read/grouping metadata.
  // Flat channel navigation never encodes it as a route segment.
  parentChannelId?: string | null
  m: Msg
}

// A single unread child thread nested under its parent channel.
type UnreadChild = {
  channelId: string
  channelName: string
  // Raw stored channel type — drives the inbox entity icon (thread →
  // MessagesSquare). Optional for backward-compat with cached responses.
  type?: EntityKind
  lastMessageAt: string
  lastUnreadSeq?: number
  lastAttentionSeq?: number | null
  mentionCount: number
  // Required together when canonical parent-opener metadata is available.
  // The child id remains the navigation target; opener seq belongs to the
  // independent parent-channel progressive read cursor.
  parentChannelId?: string
  openerMessageId?: string
  openerSeq?: number
  openerUnread?: boolean
}

// "Unreads" — channels with unread messages, grouped by server. Each channel
// may carry `children` (unread child threads) rendered as indented
// sub-rows; a parent can appear solely to host unread children.
export type UnreadServer = {
  serverId: string
  serverName: string
  channels: Array<{
    channelId: string
    channelName: string
    // Raw stored channel type — drives the inbox entity icon so a forum
    // channel shows the forum glyph, not a generic hash.
    type?: EntityKind
    lastMessageAt: string
    lastUnreadSeq?: number
    lastAttentionSeq?: number | null
    mentionCount: number
    hasDirectUnread?: boolean
    children: UnreadChild[]
  }>
}

// "Unreads" — DMs with unread messages, rendered as a flat sibling section
// under the same Unreads tab as channels.
export type UnreadDm = {
  // The DM's channel id (a DM is a channel now). Kept as the row's stable key
  // and the value passed to `onOpenDm` / the `/c/me/:id` route.
  channelId: string
  otherUserId: string
  otherUserName: string
  otherUserDiscriminator: string
  otherUserAvatar: string
  otherUserAvatarVersion: number
  lastMessageAt: string
  lastUnreadSeq?: number
}
