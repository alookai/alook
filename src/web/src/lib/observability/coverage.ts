export const pageRoutes = [
  "/",
  "/blog",
  "/blog/[slug]",
  "/c",
  "/c/channels/[serverId]",
  "/c/channels/[serverId]/[channelId]",
  "/c/channels/[serverId]/settings",
  "/c/invite/[token]",
  "/c/me",
  "/c/me/[dmId]",
  "/c/me/bots",
  "/c/me/friends",
  "/c/me/machines",
  "/c/onboarding-preview",
  "/device",
  "/landing-legacy",
  "/onboarding-preview",
  "/pricing",
  "/pricing-concept",
  "/privacy",
  "/sign-in",
  "/templates",
  "/templates/[id]",
] as const

export const apiRoutes = [
  "/api/agent-links",
  "/api/agent-links/[id]",
  "/api/agents",
  "/api/agents/[id]",
  "/api/agents/[id]/access",
  "/api/agents/[id]/access/[userId]",
  "/api/agents/[id]/active-tasks",
  "/api/agents/[id]/activity",
  "/api/agents/[id]/chat-init",
  "/api/agents/[id]/conversation",
  "/api/agents/[id]/conversations",
  "/api/agents/[id]/email-accounts",
  "/api/agents/[id]/email-accounts/[accountId]",
  "/api/agents/[id]/email-accounts/[accountId]/sync",
  "/api/agents/[id]/email-accounts/[accountId]/test",
  "/api/agents/[id]/meetings",
  "/api/agents/[id]/meetings/[meetingId]",
  "/api/agents/[id]/meetings/[meetingId]/approve",
  "/api/agents/[id]/meetings/[meetingId]/stop",
  "/api/agents/[id]/pin",
  "/api/agents/[id]/skills",
  "/api/agents/[id]/threads",
  "/api/agents/[id]/whitelist",
  "/api/agents/[id]/whitelist/[whitelistId]",
  "/api/agents/[id]/workspace/browse",
  "/api/agents/active-task-counts",
  "/api/agents/active-tasks",
  "/api/agents/pins",
  "/api/agents/pins/reorder",
  "/api/agents/recruit",
  "/api/agents/sidebar/reorder",
  "/api/artifacts",
  "/api/artifacts/[id]",
  "/api/artifacts/[id]/content",
  "/api/artifacts/[id]/thumbnail",
  "/api/artifacts/upload",
  "/api/auth/[...all]",
  "/api/auth/native/attempt",
  "/api/auth/native/cancel",
  "/api/auth/native/exchange",
  "/api/auth/native/status",
  "/api/calendar",
  "/api/calendar/[id]",
  "/api/channels",
  "/api/channels/[id]",
  "/api/channels/reorder",
  "/api/cli/latest-version",
  "/api/community/analytics/funnel-events",
  "/api/community/billing",
  "/api/community/billing/cancel-change",
  "/api/community/billing/checkout",
  "/api/community/billing/portal",
  "/api/community/bots",
  "/api/community/bots/[id]",
  "/api/community/bots/[id]/active",
  "/api/community/bots/[id]/approval-requests/[requestId]/approve",
  "/api/community/bots/[id]/approval-requests/[requestId]/deny",
  "/api/community/bots/[id]/audit-log",
  "/api/community/bots/[id]/avatar",
  "/api/community/bots/[id]/diagnostics",
  "/api/community/bots/[id]/marks",
  "/api/community/bots/[id]/notifications/channel/[scopeId]",
  "/api/community/bots/[id]/notifications/server/[scopeId]",
  "/api/community/bots/[id]/reset-session",
  "/api/community/bots/me/nap",
  "/api/community/channels",
  "/api/community/channels/[id]",
  "/api/community/channels/[id]/attachments",
  "/api/community/channels/[id]/attachments/[attachmentId]",
  "/api/community/channels/[id]/attachments/[attachmentId]/thumbnail",
  "/api/community/channels/[id]/members",
  "/api/community/channels/[id]/members/[userId]",
  "/api/community/channels/[id]/messages",
  "/api/community/channels/[id]/messages/seq/[seq]",
  "/api/community/channels/[id]/messages/tags",
  "/api/community/channels/[id]/participants",
  "/api/community/channels/[id]/participants/[userId]",
  "/api/community/channels/[id]/pins",
  "/api/community/channels/[id]/pins/[messageId]",
  "/api/community/channels/[id]/read",
  "/api/community/channels/[id]/read-state",
  "/api/community/channels/[id]/threads",
  "/api/community/channels/[id]/upload",
  "/api/community/channels/participants/batch",
  "/api/community/daemon/activate",
  "/api/community/daemon/bots",
  "/api/community/daemon/diagnostics/[reportId]",
  "/api/community/daemon/diagnostics/[reportId]/bundle",
  "/api/community/daemon/enroll-agent",
  "/api/community/daemon/identity",
  "/api/community/daemon/resync-diagnostics",
  "/api/community/daemon/resync-wakes",
  "/api/community/diagnostics/[reportId]",
  "/api/community/friends/[id]",
  "/api/community/friends/[id]/accept",
  "/api/community/friends/[id]/owner-decision",
  "/api/community/friends/[id]/reject",
  "/api/community/friends/accepted",
  "/api/community/friends/blocked",
  "/api/community/friends/pending",
  "/api/community/friends/presence",
  "/api/community/friends/request",
  "/api/community/invites/[token]",
  "/api/community/invites/[token]/info",
  "/api/community/invites/[token]/join",
  "/api/community/machines",
  "/api/community/machines/[id]",
  "/api/community/machines/[id]/reconnect",
  "/api/community/machines/[id]/reset-agents",
  "/api/community/machines/[id]/update",
  "/api/community/machines/pair",
  "/api/community/messages/[id]",
  "/api/community/messages/[id]/marks",
  "/api/community/messages/[id]/properties",
  "/api/community/messages/[id]/reactions",
  "/api/community/messages/[id]/reactions/[emoji]",
  "/api/community/messages/[id]/tags",
  "/api/community/messages/batch",
  "/api/community/messages/search",
  "/api/community/messages/tags/batch",
  "/api/community/notifications/devices",
  "/api/community/notifications/devices/[installationId]",
  "/api/community/servers",
  "/api/community/servers/[id]",
  "/api/community/servers/[id]/bots",
  "/api/community/servers/[id]/categories",
  "/api/community/servers/[id]/categories/[catId]",
  "/api/community/servers/[id]/categories/reorder",
  "/api/community/servers/[id]/channels",
  "/api/community/servers/[id]/channels/admin",
  "/api/community/servers/[id]/channels/reorder",
  "/api/community/servers/[id]/icon",
  "/api/community/servers/[id]/invites",
  "/api/community/servers/[id]/leave",
  "/api/community/servers/[id]/members",
  "/api/community/servers/[id]/members/[memberId]",
  "/api/community/servers/[id]/members/search",
  "/api/community/servers/[id]/onboard",
  "/api/community/servers/[id]/presence",
  "/api/community/servers/[id]/unreads",
  "/api/community/servers/channels",
  "/api/community/share-image/avatar/[userId]",
  "/api/community/users/[userId]/avatar",
  "/api/community/users/[userId]/block",
  "/api/community/users/[userId]/profile",
  "/api/community/users/[userId]/unblock",
  "/api/community/users/me/account-deletion",
  "/api/community/users/me/account-deletion/code",
  "/api/community/users/me/attention",
  "/api/community/users/me/avatar",
  "/api/community/users/me/channel-directory",
  "/api/community/users/me/dms",
  "/api/community/users/me/inbox/ack",
  "/api/community/users/me/inbox/dms/read-all",
  "/api/community/users/me/inbox/mentions/[id]",
  "/api/community/users/me/inbox/mentions/read-all",
  "/api/community/users/me/inbox/pull",
  "/api/community/users/me/inbox/snapshot",
  "/api/community/users/me/inbox/unreads/read-all",
  "/api/community/users/me/marks",
  "/api/community/users/me/notifications",
  "/api/community/users/me/notifications/channel/[id]",
  "/api/community/users/me/notifications/server/[id]",
  "/api/community/users/me/profile",
  "/api/community/users/me/read-state",
  "/api/community/users/me/server-folders",
  "/api/community/users/me/server-folders/[id]",
  "/api/community/users/me/server-folders/reorder",
  "/api/community/users/me/server-rail",
  "/api/community/users/search",
  "/api/config/min-version",
  "/api/config/model-options",
  "/api/conversations",
  "/api/conversations/[id]",
  "/api/conversations/[id]/active-task",
  "/api/conversations/[id]/init",
  "/api/conversations/[id]/messages",
  "/api/conversations/[id]/threads",
  "/api/conversations/check-fresh",
  "/api/daemon/conversations/[id]/messages",
  "/api/daemon/deregister",
  "/api/daemon/heartbeat",
  "/api/daemon/latest-version",
  "/api/daemon/register",
  "/api/daemon/skills/sync",
  "/api/daemon/sweep",
  "/api/daemon/tasks/[taskId]/complete",
  "/api/daemon/tasks/[taskId]/fail",
  "/api/daemon/tasks/[taskId]/messages",
  "/api/daemon/tasks/[taskId]/progress",
  "/api/daemon/tasks/[taskId]/start",
  "/api/daemon/tasks/[taskId]/status",
  "/api/daemon/tasks/[taskId]/supersede",
  "/api/daemon/tasks/poll",
  "/api/daemon/workspace/report",
  "/api/daily-quote",
  "/api/desktop/update/[target]/[arch]/[current_version]",
  "/api/email",
  "/api/email/[id]",
  "/api/email/[id]/attachment/[index]",
  "/api/email/[id]/body",
  "/api/email/[id]/raw",
  "/api/email/[id]/thread",
  "/api/email/[id]/trust",
  "/api/email/notify",
  "/api/email/send",
  "/api/email/upload",
  "/api/flags",
  "/api/flags/[messageId]",
  "/api/flags/count",
  "/api/health",
  "/api/inbox",
  "/api/inbox/count",
  "/api/inbox/read",
  "/api/inbox/read-all",
  "/api/invite/[token]",
  "/api/issues",
  "/api/issues/[id]",
  "/api/issues/[id]/comments",
  "/api/machine-tokens",
  "/api/machine-tokens/[id]",
  "/api/machine-tokens/activate",
  "/api/machine-tokens/status",
  "/api/me",
  "/api/meeting/callback",
  "/api/members/me",
  "/api/pricing",
  "/api/privacy/analytics-consent",
  "/api/runtimes",
  "/api/runtimes/[runtimeId]/rescan",
  "/api/runtimes/[runtimeId]/update",
  "/api/runtimes/machine",
  "/api/stripe/webhook",
  "/api/studios",
  "/api/studios/check-handles",
  "/api/studios/check-name",
  "/api/tasks/[id]",
  "/api/tasks/[id]/messages",
  "/api/tasks/[id]/retry",
  "/api/traces",
  "/api/traces/[traceId]",
  "/api/workspaces",
  "/api/workspaces/[id]",
  "/api/workspaces/[id]/invites",
  "/api/workspaces/[id]/invites/[inviteId]",
  "/api/workspaces/[id]/members",
  "/api/workspaces/[id]/members/[memberId]",
  "/api/workspaces/[id]/onboarded",
  "/api/workspaces/[id]/overview",
  "/api/ws/token"
] as const

export const actionNames = [
  "account.delete",
  "account.deletion.code.request",
  "account.deletion.command",
  "account.sign_out",
  "attachment.download",
  "attachment.prepare",
  "attachment.upload",
  "attachment_preview",
  "auth_dev_sign_in",
  "auth_send_code",
  "auth_social",
  "auth_verify_code",
  "billing.change.cancel",
  "billing.checkout.start",
  "billing.portal.open",
  "billing.redirect",
  "billing_return",
  "bot.active.change",
  "bot.avatar.upload",
  "bot.bug_report.submit",
  "bot.command",
  "bot.create",
  "bot.delete",
  "bot.notification.update",
  "bot.session.reset",
  "bot.update",
  "cache.clear",
  "category.create",
  "category.delete",
  "category.reorder",
  "category.update",
  "channel.create",
  "channel.delete",
  "channel.member.add",
  "channel.member.leave",
  "member.management.command",
  "channel.member.command",
  "channel.member.remove",
  "channel.members.add",
  "channel.members.remove",
  "channel.message.send",
  "channel.move",
  "channel.rename",
  "channel.reorder",
  "command.unknown",
  "community.command",
  "community.onboarding.initialize",
  "device.authorization.approve",
  "device.authorization.command",
  "device.authorization.deny",
  "dm.message.send",
  "dm.open",
  "forum.tags.update",
  "forum.thread.create",
  "forum.thread.delete",
  "inbox.read_all",
  "invitation.copy",
  "invitation.send",
  "machine.agents.reset",
  "machine.command",
  "machine.delete",
  "machine.pair.generate",
  "machine.pair.launch",
  "machine.update",
  "mention.dismiss",
  "message.compose.send",
  "message.edit",
  "message.export",
  "message.mark",
  "message.mark.command",
  "message.pin",
  "message.pin.command",
  "message.reaction.add",
  "message.reaction.command",
  "message.reaction.toggle",
  "message.thread.create",
  "message.unmark",
  "message.unpin",
  "message_send",
  "navigation",
  "notification.channel.update",
  "notification.server.update",
  "notification.settings.command",
  "profile.avatar.upload",
  "profile.update",
  "router_transition",
  "server.create",
  "server.delete",
  "server.icon.upload",
  "server.invite.accept",
  "server.invite.resolve",
  "server.invite.revoke",
  "server.join",
  "server.leave",
  "server.member.command",
  "server.member.kick",
  "server.member.role.change",
  "server.rail.reorder",
  "server.update",
  "ui_interaction",
  "friend.command",
  "friend.owner_decision.command",
  "friend.request.send",
  "friend.request.accept",
  "friend.request.reject",
  "friend.remove",
  "friend.request.cancel",
  "friend.request.approve",
  "friend.request.deny",
  "user.block",
  "user.unblock"
] as const

export const mutationCoverage = [
  {
    "file": "src/web/src/app/c/invite/[token]/invite-accept-client.tsx",
    "owner": "InviteAcceptInner",
    "action": "server.invite.accept"
  },
  {
    "file": "src/web/src/app/device/page.tsx",
    "owner": "DeviceAuthPageInner",
    "action": "device.authorization.command"
  },
  {
    "file": "src/web/src/components/community/machines/machine-list.tsx",
    "owner": "MachineList",
    "action": "machine.command"
  },
  {
    "file": "src/web/src/components/community/machines/pair-machine-sheet.tsx",
    "owner": "PairMachineSheet",
    "action": "machine.pair.generate"
  },
  {
    "file": "src/web/src/components/community/machines/pair-machine-sheet.tsx",
    "owner": "PairMachineSheet",
    "action": "machine.pair.launch"
  },
  {
    "file": "src/web/src/components/community/members/add-members-dialog.tsx",
    "owner": "AddMembersDialog",
    "action": "channel.members.add"
  },
  {
    "file": "src/web/src/components/community/members/member-list.tsx",
    "owner": "MemberList",
    "action": "member.management.command"
  },
  {
    "file": "src/web/src/components/community/messages/create-forum-thread.tsx",
    "owner": "CreateForumThread",
    "action": "forum.thread.create"
  },
  {
    "file": "src/web/src/components/community/messages/message-share-dialog.tsx",
    "owner": "MessageShareDialog",
    "action": "message.export"
  },
  {
    "file": "src/web/src/components/community/messages/use-composer-controller.ts",
    "owner": "useComposerController",
    "action": "message.compose.send"
  },
  {
    "file": "src/web/src/components/community/onboarding/community-onboarding-form.tsx",
    "owner": "CommunityOnboardingForm",
    "action": "community.onboarding.initialize"
  },
  {
    "file": "src/web/src/components/community/onboarding/onboarding-machine-dialog.tsx",
    "owner": "OnboardingMachineDialog",
    "action": "machine.pair.generate"
  },
  {
    "file": "src/web/src/components/community/settings/account-deletion-flow.tsx",
    "owner": "AccountDeletionFlow",
    "action": "account.deletion.command"
  },
  {
    "file": "src/web/src/components/community/settings/user-settings.tsx",
    "owner": "AdvancedSettings",
    "action": "cache.clear"
  },
  {
    "file": "src/web/src/components/community/social/invite-dialog.tsx",
    "owner": "InviteDialog",
    "action": "invitation.send"
  },
  {
    "file": "src/web/src/components/community/social/invite-dialog.tsx",
    "owner": "InviteDialog",
    "action": "invitation.copy"
  },
  {
    "file": "src/web/src/hooks/community/mutations/dm.ts",
    "owner": "useCreateOrGetDm",
    "action": "dm.open"
  },
  {
    "file": "src/web/src/hooks/community/mutations/forum.ts",
    "owner": "useCreateForumThread",
    "action": "forum.thread.create"
  },
  {
    "file": "src/web/src/hooks/community/mutations/forum.ts",
    "owner": "useUpdatePostTags",
    "action": "forum.tags.update"
  },
  {
    "file": "src/web/src/hooks/community/mutations/forum.ts",
    "owner": "useDeleteForumThread",
    "action": "forum.thread.delete"
  },
  {
    "file": "src/web/src/hooks/community/mutations/invites.ts",
    "owner": "useResolveOrCreateInvite",
    "action": "server.invite.resolve"
  },
  {
    "file": "src/web/src/hooks/community/mutations/invites.ts",
    "owner": "useRevokeInvite",
    "action": "server.invite.revoke"
  },
  {
    "file": "src/web/src/hooks/community/mutations/members.ts",
    "owner": "useMemberCommand",
    "action": "server.member.command"
  },
  {
    "file": "src/web/src/hooks/community/mutations/message-memberships.ts",
    "owner": "usePinCommand",
    "action": "message.pin.command"
  },
  {
    "file": "src/web/src/hooks/community/mutations/message-memberships.ts",
    "owner": "useMarkCommand",
    "action": "message.mark.command"
  },
  {
    "file": "src/web/src/hooks/community/mutations/message-reactions.ts",
    "owner": "useReactionIntent",
    "action": "message.reaction.command"
  },
  {
    "file": "src/web/src/hooks/community/mutations/messages.ts",
    "owner": "useEditMessage",
    "action": "message.edit"
  },
  {
    "file": "src/web/src/hooks/community/mutations/messages.ts",
    "owner": "useSendMessage",
    "action": "channel.message.send"
  },
  {
    "file": "src/web/src/hooks/community/mutations/messages.ts",
    "owner": "useSendDmMessage",
    "action": "dm.message.send"
  },
  {
    "file": "src/web/src/hooks/community/mutations/messages.ts",
    "owner": "useCreateThread",
    "action": "message.thread.create"
  },
  {
    "file": "src/web/src/hooks/community/mutations/messages.ts",
    "owner": "useMarkAllInboxRead",
    "action": "inbox.read_all"
  },
  {
    "file": "src/web/src/hooks/community/mutations/messages.ts",
    "owner": "useDeleteMention",
    "action": "mention.dismiss"
  },
  {
    "file": "src/web/src/hooks/community/mutations/notifications.ts",
    "owner": "useNotificationCommand",
    "action": "notification.settings.command"
  },
  {
    "file": "src/web/src/hooks/community/mutations/profile.ts",
    "owner": "useUpdateProfile",
    "action": "profile.update"
  },
  {
    "file": "src/web/src/hooks/community/mutations/profile.ts",
    "owner": "useUploadUserAvatar",
    "action": "profile.avatar.upload"
  },
  {
    "file": "src/web/src/hooks/community/mutations/uploads.ts",
    "owner": "useUploadFile",
    "action": "attachment.upload"
  },
  {
    "file": "src/web/src/hooks/community/use-account-sign-out.ts",
    "owner": "useAccountSignOut",
    "action": "account.sign_out"
  },
  {
    "file": "src/web/src/hooks/community/use-billing.ts",
    "owner": "useBilling",
    "action": "billing.redirect"
  },
  {
    "file": "src/web/src/hooks/community/use-billing.ts",
    "owner": "useBilling",
    "action": "billing.change.cancel"
  },
  {
    "file": "src/web/src/hooks/community/use-bot-bug-report.ts",
    "owner": "useBotBugReport",
    "action": "bot.bug_report.submit"
  },
  {
    "file": "src/web/src/hooks/community/use-bots.ts",
    "owner": "useBotCommand",
    "action": "bot.command"
  },
  {
    "file": "src/web/src/hooks/community/use-channel-members.ts",
    "owner": "useChannelMemberCommand",
    "action": "channel.member.command"
  },
  {
    "file": "src/web/src/hooks/community/use-community-command-mutation.ts",
    "owner": "useCommunityCommandMutation",
    "action": "community.command"
  },
  {
    "file": "src/web/src/hooks/community/use-notification-settings.ts",
    "owner": "useSetBotNotificationSetting",
    "action": "bot.notification.update"
  },
  {
    "file": "src/web/src/hooks/use-file-attachments.ts",
    "owner": "useFileAttachments",
    "action": "attachment.prepare"
  }
] as const

export const facadeCoverage = [
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useCreateChannel",
    "action": "channel.create"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useRenameChannel",
    "action": "channel.rename"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useMoveChannel",
    "action": "channel.move"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useDeleteChannel",
    "action": "channel.delete"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useCreateCategory",
    "action": "category.create"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useUpdateCategory",
    "action": "category.update"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useDeleteCategory",
    "action": "category.delete"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useReorderCategories",
    "action": "category.reorder"
  },
  {
    "file": "src/web/src/hooks/community/mutations/channels.ts",
    "owner": "useReorderChannels",
    "action": "channel.reorder"
  },
  {
    "file": "src/web/src/hooks/community/mutations/friends.ts",
    "owner": "useFriendCommand",
    "action": "friend.command"
  },
  {
    "file": "src/web/src/hooks/community/mutations/server-rail.ts",
    "owner": "useServerRailCommit",
    "action": "server.rail.reorder"
  },
  {
    "file": "src/web/src/hooks/community/mutations/servers.ts",
    "owner": "useCreateServer",
    "action": "server.create"
  },
  {
    "file": "src/web/src/hooks/community/mutations/servers.ts",
    "owner": "useJoinServer",
    "action": "server.join"
  },
  {
    "file": "src/web/src/hooks/community/mutations/servers.ts",
    "owner": "useLeaveServer",
    "action": "server.leave"
  },
  {
    "file": "src/web/src/hooks/community/mutations/servers.ts",
    "owner": "useDeleteServer",
    "action": "server.delete"
  },
  {
    "file": "src/web/src/hooks/community/mutations/servers.ts",
    "owner": "useUpdateServer",
    "action": "server.update"
  },
  {
    "file": "src/web/src/hooks/community/mutations/servers.ts",
    "owner": "useUploadServerIcon",
    "action": "server.icon.upload"
  }
] as const

export const capabilityLimits = {
  auth_worker: "separate status HTML has no consent-aware client bundle",
  external_oauth: "in-app handoff and return only",
  stripe: "in-app handoff and qualified billing return only",
  native_os: "platform timing and lifecycle require independent verification",
  rsc_cache: "public router intent; cache hit unknown without public evidence",
  backend_trace: "cf-ray correlation; same-trace backend unverified",
  ssr_source: "server-rendered source unknown unless an explicit owner supplies evidence",
} as const

const routeMatchers = [...pageRoutes, ...apiRoutes].sort((a,b) => b.split("/").length-a.split("/").length || b.split("/").filter(part => !part.startsWith("[")).length-a.split("/").filter(part => !part.startsWith("[")).length || a.localeCompare(b)).map(template => {
  const pattern = template.split("/").slice(1).map(part => part.startsWith("[[...") ? "(?:/.*)?" : "/" + (part.startsWith("[...") ? ".+" : part.startsWith("[") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")
  return { template, pattern: new RegExp("^" + pattern + "/?$") }
})
export function routeTemplate(input: string, origin = "https://alook.ai"): string {
  try {
    const url = new URL(input, origin)
    if (url.origin !== new URL(origin).origin) return "/external"
    if (url.pathname.startsWith("/_next/")) return "/_next/resource"
    return routeMatchers.find(({pattern}) => pattern.test(url.pathname))?.template ?? "/unmapped"
  } catch { return "/unmapped" }
}
