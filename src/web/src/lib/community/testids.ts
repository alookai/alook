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
  machinePairOpen: "community-machine-pair-open",
  machinePairCommand: "community-machine-pair-command",
  machinePairCopy: "community-machine-pair-copy",
  homeButton: "community-home-button",
  alookLogo: "community-alook-logo",
  botReportProblemItem: "bot-report-problem-item",
  botReportProblemDialog: "bot-report-problem-dialog",
  botReportProblemSubmit: "bot-report-problem-submit",
  botReportProblemStatus: "bot-report-problem-status",
  botAvatarPickerTrigger: "community-bot-avatar-picker-trigger",

  forumTagDialog: "community-forum-tag-dialog",

  message: (id: string) => `community-message-${id}`,
  channelRow: (id: string) => `community-channel-row-${id}`,
  serverIcon: (id: string) => `community-server-icon-${id}`,
  dmRow: (id: string) => `community-dm-row-${id}`,
  memberRow: (id: string) => `community-member-row-${id}`,
  mentionOption: (id: string) => `community-mention-option-${id}`,
  reactionAdd: (msgId: string) => `community-reaction-add-${msgId}`,
  messageShare: (msgId: string) => `community-message-share-${msgId}`,
  messageShareCopy: `community-message-share-copy`,
  threadIndicator: (msgId: string) => `community-thread-indicator-${msgId}`,
  railUnreadBadge: (serverId: string) => `community-rail-unread-badge-${serverId}`,
  // Forum post feed (ForumView). `forumThreadCard` is the whole clickable card;
  // `forumThreadTagBtn` is the hover-revealed tag-edit icon; `forumThreadDeleteBtn`
  // is the hover-revealed delete icon; `forumThreadAvatars` wraps the participant
  // AvatarGroup; `forumTagChip` is a filter-bar tag chip.
  forumThreadCard: (id: string) => `community-forum-post-${id}`,
  forumSidebarThread: (id: string) => `community-forum-sidebar-thread-${id}`,
  forumThreadTagBtn: (id: string) => `community-forum-post-tag-btn-${id}`,
  forumThreadDeleteBtn: (id: string) => `community-forum-post-delete-btn-${id}`,
  forumThreadAvatars: (id: string) => `community-forum-post-avatars-${id}`,
  forumTagChip: (tag: string) => `community-forum-tag-chip-${tag}`,
  inboxUnreadChild: (id: string) => `community-inbox-unread-child-${id}`,
  channelRefPill: (id: string) => `community-channel-ref-pill-${id}`,
} as const
