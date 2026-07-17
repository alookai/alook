// Single source of truth for community `data-testid` values. Imported by both
// product components (so the attribute strings are never hand-typed) and the
// Playwright specs (via _fixtures/testids). Naming: community-<区域>-<元素>[-<标识>].
export const tid = {
  composerInput: "community-composer-input",
  composerSend: "community-composer-send",
  composerAttach: "community-composer-attach",
  serverAdd: "community-server-add",
  createServerSubmit: "community-create-server-submit",
  createChannelSubmit: "community-create-channel-submit",
  newDivider: "community-new-divider",
  typingIndicator: "community-typing-indicator",
  dmBlockedNotice: "community-dm-blocked-notice",
  profileCard: "community-profile-card",
  statusPill: "community-status-pill",
  inviteToken: "community-invite-token",
  inviteCopy: "community-invite-copy",

  message: (id: string) => `community-message-${id}`,
  channelRow: (id: string) => `community-channel-row-${id}`,
  serverIcon: (id: string) => `community-server-icon-${id}`,
  dmRow: (id: string) => `community-dm-row-${id}`,
  memberRow: (id: string) => `community-member-row-${id}`,
  mentionOption: (id: string) => `community-mention-option-${id}`,
  reactionAdd: (msgId: string) => `community-reaction-add-${msgId}`,
  threadIndicator: (msgId: string) => `community-thread-indicator-${msgId}`,
  railUnreadBadge: (serverId: string) => `community-rail-unread-badge-${serverId}`,
} as const
