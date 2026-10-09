import { readFileSync, readdirSync } from "node:fs"
import { resolve, relative } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"
import { actionNames, pageRoutes } from "./coverage"
import { actionVariants } from "./actions"

const web = resolve(import.meta.dirname, "../../..")
const files = (root: string) => readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === "string" && /\.tsx?$/.test(file)).map(file => resolve(root, file))
it("keeps the route whitelist aligned with both builds and parallel route slots", () => {
  const routes = new Set(["src/app", "blog/src/app"].flatMap(root => files(resolve(web, root)).filter(file => file.endsWith("/page.tsx")).map(file => "/" + relative(resolve(web, root), file).split("/").slice(0, -1).filter(segment => !segment.startsWith("(") && !segment.startsWith("@")).join("/"))))
  expect([...routes].sort()).toEqual([...pageRoutes].sort())
})
it("keeps existing mutation owners inventoried and semantic variants on the whitelist", () => {
  const inventory = new Set<string>([...mutationCoverage, ...facadeCoverage].map(entry => entry.file))
  for (const file of files(resolve(web, "src"))) {
    if (/\.test\./.test(file) || file.includes("/test/")) continue
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ["useMutation", "useCommunityCommandMutation"].includes(node.expression.getText(source))) {
        expect(inventory.has("src/web/" + relative(web, file)), file).toBe(true)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const variants of Object.values(actionVariants)) for (const name of Object.values(variants)) expect(actionNames as readonly string[]).toContain(name)
})

const mutationCoverage = [
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

const facadeCoverage = [
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
