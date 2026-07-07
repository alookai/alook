/**
 * TanStack Query key factory for the community feature.
 *
 * Rules:
 * - Every key is `as const` so its literal-tuple type is preserved for
 *   `queryClient.setQueryData` / `invalidateQueries` inference.
 * - Every key derived from a parent extends the parent's tuple, so
 *   `invalidateQueries({ queryKey: communityKeys.inbox() })` invalidates all
 *   three inbox feeds under it, `invalidateQueries({ queryKey: communityKeys.server(id) })`
 *   invalidates every subkey of that server, and so on.
 * - Parameterisation matches the underlying route params. Message list keys
 *   include an optional cursor so pagination pages nest under a stable
 *   channel-scoped root (useful for `useInfiniteQuery` and for invalidating
 *   all pages of one channel in a single call).
 */
export const communityKeys = {
  all: ["community"] as const,

  // ── Servers ──────────────────────────────────────────────────────────────
  servers: () => [...communityKeys.all, "servers"] as const,
  server: (serverId: string) =>
    [...communityKeys.servers(), serverId] as const,

  // ── Server-scoped resources ─────────────────────────────────────────────
  members: (serverId: string) =>
    [...communityKeys.server(serverId), "members"] as const,
  presence: (serverId: string) =>
    [...communityKeys.server(serverId), "presence"] as const,
  auditLog: (serverId: string) =>
    [...communityKeys.server(serverId), "audit-log"] as const,
  invites: (serverId: string) =>
    [...communityKeys.server(serverId), "invites"] as const,
  invitableFriends: (serverId: string) =>
    [...communityKeys.server(serverId), "invitable-friends"] as const,
  // Server metadata fetched for an inline invite card (token → serverName /
  // icon / memberCount). Not scoped under a server since the token is what we
  // have — the id/serverId only comes back with the response.
  inviteInfo: (token: string) =>
    [...communityKeys.all, "invite-info", token] as const,

  // ── Channel-scoped resources ────────────────────────────────────────────
  // Message list roots are keyed by channelId so paginated pages nest under
  // a stable prefix. Cursor-specific keys use `channelMessagesPage`; consumers
  // that want to invalidate every page of a channel use `channelMessages`.
  channelMessages: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "messages"] as const,
  channelMessagesPage: (channelId: string, cursor?: string | null) =>
    [...communityKeys.channelMessages(channelId), cursor ?? null] as const,

  dmMessages: (dmId: string) =>
    [...communityKeys.all, "dm", dmId, "messages"] as const,
  dmMessagesPage: (dmId: string, cursor?: string | null) =>
    [...communityKeys.dmMessages(dmId), cursor ?? null] as const,

  pins: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "pins"] as const,
  threads: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "threads"] as const,
  forumPosts: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "posts"] as const,
  // #3: the viewer's `communityReadState` row for a single channel, fetched
  // once per channel mount and frozen thereafter so the "New" divider stays
  // anchored while the watermark advances.
  channelReadStateSnapshot: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "read-state-snapshot"] as const,

  // Single hydrated message (opener block, deep-link previews).
  message: (messageId: string) =>
    [...communityKeys.all, "message", messageId] as const,

  // ── Inbox ───────────────────────────────────────────────────────────────
  inbox: () => [...communityKeys.all, "inbox"] as const,
  inboxUnreads: () => [...communityKeys.inbox(), "unreads"] as const,
  inboxForYou: () => [...communityKeys.inbox(), "foryou"] as const,
  inboxMentions: () => [...communityKeys.inbox(), "mentions"] as const,

  // ── Social ──────────────────────────────────────────────────────────────
  friends: () => [...communityKeys.all, "friends"] as const,
  friendsPresence: () => [...communityKeys.friends(), "presence"] as const,
  dms: () => [...communityKeys.all, "dms"] as const,
  folders: () => [...communityKeys.all, "folders"] as const,

  // ── Machines / daemons ──────────────────────────────────────────────────
  machines: () => [...communityKeys.all, "machines"] as const,

  // ── Bots ────────────────────────────────────────────────────────────────
  bots: () => [...communityKeys.all, "bots"] as const,

  // ── Notification settings ───────────────────────────────────────────────
  notificationSettings: () =>
    [...communityKeys.all, "notification-settings"] as const,

  // ── Profile / user cards ────────────────────────────────────────────────
  profile: (userId: string) =>
    [...communityKeys.all, "profile", userId] as const,
} as const

