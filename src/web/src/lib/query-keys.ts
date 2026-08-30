/**
 * TanStack Query key factory for the community feature.
 *
 * Rules:
 * - Every key is `as const` so its literal-tuple type is preserved for
 *   `queryClient.setQueryData` / `invalidateQueries` inference.
 * - Every key derived from a parent extends the parent's tuple, so
 *   `invalidateQueries({ queryKey: communityKeys.inbox() })` invalidates both
 *   inbox feeds under it, `invalidateQueries({ queryKey: communityKeys.server(id) })`
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
  channelRefDirectory: () =>
    [...communityKeys.servers(), "channel-ref-directory"] as const,
  server: (serverId: string) =>
    [...communityKeys.servers(), serverId] as const,
  forumSidebarThreads: (serverId: string) =>
    [...communityKeys.server(serverId), "forum-sidebar-base"] as const,
  forumSidebarRetainedRoot: (serverId: string) =>
    [...communityKeys.server(serverId), "forum-sidebar-retained"] as const,
  forumSidebarRetained: (serverId: string, childId: string) =>
    [...communityKeys.forumSidebarRetainedRoot(serverId), childId] as const,
  channelMetaRoot: (serverId: string) =>
    [...communityKeys.server(serverId), "channel-meta"] as const,
  channelMeta: (serverId: string, channelId: string) =>
    [...communityKeys.channelMetaRoot(serverId), channelId] as const,
  forumOpenerHintRoot: (serverId: string) =>
    [...communityKeys.server(serverId), "forum-opener-hint"] as const,
  forumOpenerHint: (serverId: string, messageId: string) =>
    [...communityKeys.forumOpenerHintRoot(serverId), messageId] as const,
  forumSidebarUnreadFallbacks: (serverId: string) =>
    [...communityKeys.server(serverId), "forum-sidebar-unread-fallbacks"] as const,

  // ── Server-scoped resources ─────────────────────────────────────────────
  members: (serverId: string) =>
    [...communityKeys.server(serverId), "members"] as const,
  presence: (serverId: string) =>
    [...communityKeys.server(serverId), "presence"] as const,
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

  // Explicit membership roster of a private-category channel + the addable
  // (not-yet-member) server members for its picker.
  channelMembers: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "members"] as const,
  channelAddableMembers: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "addable-members"] as const,

  // A thread's notify participant set.
  threadParticipants: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "participants"] as const,

  pins: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "pins"] as const,
  threads: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "threads"] as const,
  forumFeeds: (channelId: string) =>
    [...communityKeys.threads(channelId), "feed"] as const,
  forumFeed: (channelId: string, tag: string | null) =>
    [...communityKeys.forumFeeds(channelId), tag] as const,
  forumTags: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "forum-tags"] as const,
  // #3: the viewer's `communityReadState` row for a single channel, fetched
  // once per channel mount and frozen thereafter so the "New" divider stays
  // anchored while the watermark advances.
  channelReadStateSnapshot: (channelId: string) =>
    [...communityKeys.all, "channel", channelId, "read-state-snapshot"] as const,
  // DM sibling of `channelReadStateSnapshot`. Same freeze semantics — the
  // hook latches the first non-null response so the "New" divider anchor
  // stays put while the progressive watermark advances.
  dmReadStateSnapshot: (dmId: string) =>
    [...communityKeys.all, "dm", dmId, "read-state-snapshot"] as const,
  accountReadStateSnapshot: () =>
    [...communityKeys.all, "read-state-snapshot"] as const,

  // Single hydrated message (opener block, deep-link previews).
  message: (messageId: string) =>
    [...communityKeys.all, "message", messageId] as const,
  messageContexts: (type: "channel" | "dm", channelId: string) =>
    [...communityKeys.all, "message-context", type, channelId] as const,
  messageContext: (type: "channel" | "dm", channelId: string, targetSeq: number | null) =>
    [...communityKeys.messageContexts(type, channelId), targetSeq] as const,
  reactionDetailsAll: () =>
    [...communityKeys.all, "reaction-details"] as const,
  reactionDetails: (messageId: string) =>
    [...communityKeys.reactionDetailsAll(), messageId] as const,

  // ── Inbox ───────────────────────────────────────────────────────────────
  inbox: () => [...communityKeys.all, "inbox"] as const,
  inboxUnreads: () => [...communityKeys.inbox(), "unreads"] as const,
  inboxMentions: () => [...communityKeys.inbox(), "mentions"] as const,
  // Per-user saved ("marked") messages, cross-channel newest-first. Nested
  // under inbox() so the WS reconciliation `invalidateQueries({ queryKey:
  // communityKeys.inbox() })` refreshes it alongside the other feeds.
  inboxMarked: () => [...communityKeys.inbox(), "marked"] as const,
  // Whether the viewer has marked a single message — fetched lazily when the
  // message's ⋯ menu opens (drives the Mark/Unmark label). Keyed per message
  // so re-opening the same menu reuses the cached answer.
  messageMarked: (messageId: string) =>
    [...communityKeys.all, "message", messageId, "marked"] as const,

  // ── Social ──────────────────────────────────────────────────────────────
  friends: () => [...communityKeys.all, "friends"] as const,
  friendsPresence: () => [...communityKeys.friends(), "presence"] as const,
  dms: () => [...communityKeys.all, "dms"] as const,
  dmRouteVerification: (dmId: string) =>
    [...communityKeys.all, "dm-route-verification", dmId] as const,
  folders: () => [...communityKeys.all, "folders"] as const,

  // ── Machines / daemons ──────────────────────────────────────────────────
  machines: () => [...communityKeys.all, "machines"] as const,

  // ── Bots ────────────────────────────────────────────────────────────────
  bots: () => [...communityKeys.all, "bots"] as const,
  bugReport: (reportId: string) =>
    [...communityKeys.all, "bug-report", reportId] as const,
  botAuditLog: (botId: string) =>
    [...communityKeys.all, "bot", botId, "audit-log"] as const,
  botAuditPreview: (botId: string) =>
    [...communityKeys.all, "bot", botId, "audit-preview"] as const,

  // ── Notification settings ───────────────────────────────────────────────
  notificationSettings: () =>
    [...communityKeys.all, "notification-settings"] as const,
  botNotificationSetting: (botId: string, scope: "server" | "channel", scopeId: string) =>
    [...communityKeys.all, "bot", botId, "notification-settings", scope, scopeId] as const,

  // ── Profile / user cards ────────────────────────────────────────────────
  profile: (userId: string) =>
    [...communityKeys.all, "profile", userId] as const,
} as const
