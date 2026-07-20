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

  forumTagDialog: "community-forum-tag-dialog",
  forumTagDialogSave: "community-forum-tag-dialog-save",

  message: (id: string) => `community-message-${id}`,
  channelRow: (id: string) => `community-channel-row-${id}`,
  serverIcon: (id: string) => `community-server-icon-${id}`,
  dmRow: (id: string) => `community-dm-row-${id}`,
  memberRow: (id: string) => `community-member-row-${id}`,
  mentionOption: (id: string) => `community-mention-option-${id}`,
  reactionAdd: (msgId: string) => `community-reaction-add-${msgId}`,
  threadIndicator: (msgId: string) => `community-thread-indicator-${msgId}`,
  railUnreadBadge: (serverId: string) => `community-rail-unread-badge-${serverId}`,
  // Forum post feed (ForumView). `forumPostCard` is the whole clickable card;
  // `forumPostTagBtn` is the hover-revealed tag-edit icon; `forumPostAvatars`
  // wraps the participant AvatarGroup; `forumTagChip` is a filter-bar tag chip.
  forumPostCard: (id: string) => `community-forum-post-${id}`,
  forumPostTagBtn: (id: string) => `community-forum-post-tag-btn-${id}`,
  forumPostAvatars: (id: string) => `community-forum-post-avatars-${id}`,
  forumTagChip: (tag: string) => `community-forum-tag-chip-${tag}`,
} as const
