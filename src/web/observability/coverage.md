# Frontend observability candidate coverage

`W` means source wiring at the named owner; it does not establish that the owner is mounted or reachable. `B` means a concrete capability boundary. Neither means a real journey or Grafana ingestion passed. Independent d185 runtime and received collector samples are qualified separately below; the follow-up correction still awaits its own exact-source builds and runtime verification. Unit/DOM contracts do not close those gaps.

## Build and collection contract

- Main `src/web/src/instrumentation-client.ts` and independent Blog `src/web/blog/src/instrumentation-client.ts` each bootstrap the pinned Faro Web SDK/tracing **2.12.1** with OpenTelemetry API **1.9.0**. Root layouts each commit their own public Next route. Community navigation commits at the qualified existing shell frame.
- Both builds receive `NEXT_PUBLIC_FARO_COLLECTOR_URL` (public HTTPS collector URL without query/credentials), `NEXT_PUBLIC_FARO_ENVIRONMENT` (`qa` or `production`), and `NEXT_PUBLIC_FARO_RELEASE` (exact lowercase 40-character Git SHA). Missing/invalid profile disables collection. Pass these during both independent builds; setting only runtime Worker variables does not change an already built client.
- Collection requires the existing analytics-consent grant. Main account changes, revoke/regrant, session expiry and reload metadata realign native Faro sessions through public APIs. Blog is an independent document/session. Existing consent UI is the authority; no second consent store.
- Jarvis owns production/QA Frontend Apps and CORS. The established QA origin is `http://localhost:3000` (local zone ingress); production is `https://alook.ai`. Local worker execution proves local behavior, not Cloudflare cloud execution. Do not add administrative Grafana credentials to client config.
- The native SDK supplies HTTP spans; helper events add headers/parse/qualification milestones without another HTTP span. Explicit command fetches run in the original action span through public OpenTelemetry context, and events carry its trace/span IDs; concurrent requests keep separate parents. RSC and reads without an explicit originating action retain the bounded attribution boundary. Backend sampling, Worker custom spans, CI, subscriptions and retention are outside this code change.

## Route dimensions

Every content route has navigation intent/commit and a supplemental fixed `ui_interaction` when no explicit semantic action starts. Explicit operations below own command results. Generic clicks do not prove business success. `W request` means API helper events and native HTTP tracing plus resource/RSC classification, subject to browser visibility. Static content carries source `unknown`, not an invented cache hit. Redirect rows end at destination content; parallel slots share the owning route and do not create a second action.

| Route template | Action | Request | Read | Ready | Exact owner / boundary |
|---|---|---|---|---|---|
| / | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/src/app/(home)/page.tsx` — static content marker |
| /blog | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/blog/src/app/blog/(index)/page.tsx` — independent Blog static content marker |
| /blog/[slug] | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/blog/src/app/blog/[slug]/page.tsx` — independent Blog rendered MDX marker |
| /c | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | redirect has no independent readable content |
| /c/channels/[serverId] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/channels/channel-sidebar-tree-owner.tsx; components/community/shell/server-sidebar-slot.tsx` — qualified revealed selector; desktop redirects to selected child |
| /c/channels/[serverId]/[channelId] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/messages/message-list.tsx; components/community/channels/forum-view.tsx; components/community/messages/thread-opener.tsx` — interactive, initially positioned visible window; forum visible posts or legal empty; opener is secondary |
| /c/channels/[serverId]/settings | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/settings/server-settings.tsx; components/community/settings/server-settings-channels.tsx` — selected member/invite/channel data or mounted local overview; hidden tabs suppressed |
| /c/invite/[token] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/c/invite/[token]/invite-accept-client.tsx` — invite Query gate |
| /c/me | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/shell/dm-sidebar-slot.tsx` — qualified DM selector; desktop may redirect |
| /c/me/[dmId] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/messages/message-list.tsx; hooks/community/use-messages.ts` — qualified interactive visible message window or legal empty |
| /c/me/bots | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/bots/bot-list-controller.ts; hooks/community/use-bots.ts` — existing list loading/usable gate |
| /c/me/friends | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/social/friends-page.tsx; hooks/community/use-friends.ts` — settled canonical/profile/presence view or legal empty |
| /c/me/machines | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/community/machines/machine-list.tsx; hooks/community/use-machines.ts` — existing list loading/usable gate |
| /c/onboarding-preview | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | redirect has no independent readable content |
| /device | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/device/page.tsx` — existing authenticated loading/step gate; local state source unknown |
| /invite/[token] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/invite/[token]/page.tsx` — invite Query admitted and mounted |
| /landing-legacy | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/src/app/landing-legacy/page.tsx` — static content marker |
| /onboarding-preview | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | redirect has no independent readable content |
| /pricing | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/pricing/pricing-client.tsx; hooks/community/use-billing.ts` — session/catalog/billing queries settled; checkout return business result |
| /pricing-concept | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | redirect has no independent readable content |
| /privacy | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/src/app/privacy/page.tsx` — static content marker |
| /sign-in | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(auth)/sign-in/sign-in-client.tsx; app/(auth)/sign-in/social-sign-in.tsx` — mounted form; OTP verification result; provider/native handoff boundary |
| /studio/new | W source navigation/semantic operations | W source API/HTTP/resource; B RSC owner attribution | W source view version/source | W source owner gate | `src/web/src/app/(app)/studio/new/client.tsx` — requires an authenticated existing workspace_id, membership and workspace; current runtime journey BLOCKED without a verified fixture |
| /templates | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/src/app/templates/page.tsx` — static content marker |
| /templates/[id] | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/src/app/templates/[id]/page.tsx` — static content marker |
| /w/[slug] | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents/[id] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/agent-chat/agent-chat-view.tsx; hooks/workspace/use-chat-data.ts` — loaded rendered canonical/optimistic chat view |
| /w/[slug]/agents/[id]/activity | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/agents/[id]/activity/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents/[id]/chat | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/components/agent-chat/agent-chat-view.tsx; hooks/workspace/use-chat-data.ts` — loaded rendered canonical/optimistic chat view |
| /w/[slug]/agents/[id]/chat/[convId] | W navigation → destination | W transport, B server redirect internals | B no independent content | destination owner | existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents/[id]/email | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/agents/[id]/email/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents/[id]/files | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/agents/[id]/files/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents/[id]/meetings | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/agents/[id]/meetings/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/agents/new | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/agents/new/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/calendar | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/calendar/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/flags | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/flags/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/help/email-setup | W navigation/gesture | W API/HTTP/resource; B RSC owner attribution | W unknown SSR | W mounted content | `src/web/src/app/(app)/w/[slug]/help/email-setup/page.tsx` — static content marker |
| /w/[slug]/home | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/home/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/issues | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/issues/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/runtimes | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/runtimes/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/settings | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/settings/{general,instruction,members,notification,pet,usages}-tab.tsx` — mounted selected tab; actual Queries; local preferences retain unknown provenance |
| /w/[slug]/traces | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/traces/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/traces/[traceId] | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/traces/[traceId]/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /w/[slug]/unread | W navigation/gesture + semantic operations | W API/HTTP/resource; B RSC owner attribution | W actual view version/source | W qualified owner gate | `src/web/src/app/(app)/w/[slug]/unread/page.tsx` — existing Query/owner pending state and actual rendered data, including legal empty |
| /workspaces | W navigation → /c/me | W transport; B server redirect internals | B no independent content | destination owner | `src/web/src/app/(app)/workspaces/page.tsx` unconditionally redirects; WorkspaceListClient source wiring is unmounted and does not cover a runtime workspace list/create journey |

### Reachability qualification

At d185, /workspaces unconditionally redirects to /c/me. WorkspaceListClient has no current mounting import; its workspace list/read/ready and workspace.create command are source wiring only, **runtime BLOCKED / NOT RUN**. An existing POST /api/workspaces handler is not a normal creation entry or an authorized fixture. /studio/new requires an existing workspace_id plus membership; /w/[slug] requires an existing workspace plus membership and redirects a non-onboarded workspace into studio. Thus all /w rows below describe source wiring or redirect ownership, not currently verified runtime coverage. These entry paths match the d8 baseline; the blocker is not attributed to Faro. No retired entry or hidden mutation is revived for QA.

The Application Provider has controlled integration/DOM checks, but its actual non-community account/reload/logout/restore journey remains **BLOCKED / NOT RUN** for this round without a verified usable workspace entry. Community Provider runtime results do not qualify the Application Provider.

## Exact page inventory

57 page files resolve to 46 unique templates. The inventory test checks actual main/Blog pages including parallel sidebar slots.

| Page file | Owning route |
|---|---|
| `src/web/blog/src/app/blog/(index)/page.tsx` | /blog |
| `src/web/blog/src/app/blog/[slug]/page.tsx` | /blog/[slug] |
| `src/web/src/app/(app)/invite/[token]/page.tsx` | /invite/[token] |
| `src/web/src/app/(app)/studio/new/page.tsx` | /studio/new |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/activity/page.tsx` | /w/[slug]/agents/[id]/activity |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/chat/[convId]/page.tsx` | /w/[slug]/agents/[id]/chat/[convId] |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/chat/page.tsx` | /w/[slug]/agents/[id]/chat |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/email/page.tsx` | /w/[slug]/agents/[id]/email |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/files/page.tsx` | /w/[slug]/agents/[id]/files |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/meetings/page.tsx` | /w/[slug]/agents/[id]/meetings |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/page.tsx` | /w/[slug]/agents/[id] |
| `src/web/src/app/(app)/w/[slug]/agents/new/page.tsx` | /w/[slug]/agents/new |
| `src/web/src/app/(app)/w/[slug]/agents/page.tsx` | /w/[slug]/agents |
| `src/web/src/app/(app)/w/[slug]/calendar/page.tsx` | /w/[slug]/calendar |
| `src/web/src/app/(app)/w/[slug]/flags/page.tsx` | /w/[slug]/flags |
| `src/web/src/app/(app)/w/[slug]/help/email-setup/page.tsx` | /w/[slug]/help/email-setup |
| `src/web/src/app/(app)/w/[slug]/home/page.tsx` | /w/[slug]/home |
| `src/web/src/app/(app)/w/[slug]/issues/page.tsx` | /w/[slug]/issues |
| `src/web/src/app/(app)/w/[slug]/page.tsx` | /w/[slug] |
| `src/web/src/app/(app)/w/[slug]/runtimes/page.tsx` | /w/[slug]/runtimes |
| `src/web/src/app/(app)/w/[slug]/settings/page.tsx` | /w/[slug]/settings |
| `src/web/src/app/(app)/w/[slug]/traces/[traceId]/page.tsx` | /w/[slug]/traces/[traceId] |
| `src/web/src/app/(app)/w/[slug]/traces/page.tsx` | /w/[slug]/traces |
| `src/web/src/app/(app)/w/[slug]/unread/page.tsx` | /w/[slug]/unread |
| `src/web/src/app/(app)/workspaces/page.tsx` | /workspaces |
| `src/web/src/app/(auth)/sign-in/page.tsx` | /sign-in |
| `src/web/src/app/(home)/page.tsx` | / |
| `src/web/src/app/c/@sidebar/channels/[serverId]/[channelId]/page.tsx` | /c/channels/[serverId]/[channelId] |
| `src/web/src/app/c/@sidebar/channels/[serverId]/page.tsx` | /c/channels/[serverId] |
| `src/web/src/app/c/@sidebar/channels/[serverId]/settings/page.tsx` | /c/channels/[serverId]/settings |
| `src/web/src/app/c/@sidebar/invite/[token]/page.tsx` | /c/invite/[token] |
| `src/web/src/app/c/@sidebar/me/[dmId]/page.tsx` | /c/me/[dmId] |
| `src/web/src/app/c/@sidebar/me/bots/page.tsx` | /c/me/bots |
| `src/web/src/app/c/@sidebar/me/friends/page.tsx` | /c/me/friends |
| `src/web/src/app/c/@sidebar/me/machines/page.tsx` | /c/me/machines |
| `src/web/src/app/c/@sidebar/me/page.tsx` | /c/me |
| `src/web/src/app/c/@sidebar/onboarding-preview/page.tsx` | /c/onboarding-preview |
| `src/web/src/app/c/@sidebar/page.tsx` | /c |
| `src/web/src/app/c/channels/[serverId]/[channelId]/page.tsx` | /c/channels/[serverId]/[channelId] |
| `src/web/src/app/c/channels/[serverId]/page.tsx` | /c/channels/[serverId] |
| `src/web/src/app/c/channels/[serverId]/settings/page.tsx` | /c/channels/[serverId]/settings |
| `src/web/src/app/c/invite/[token]/page.tsx` | /c/invite/[token] |
| `src/web/src/app/c/me/[dmId]/page.tsx` | /c/me/[dmId] |
| `src/web/src/app/c/me/bots/page.tsx` | /c/me/bots |
| `src/web/src/app/c/me/friends/page.tsx` | /c/me/friends |
| `src/web/src/app/c/me/machines/page.tsx` | /c/me/machines |
| `src/web/src/app/c/me/page.tsx` | /c/me |
| `src/web/src/app/c/onboarding-preview/page.tsx` | /c/onboarding-preview |
| `src/web/src/app/c/page.tsx` | /c |
| `src/web/src/app/device/page.tsx` | /device |
| `src/web/src/app/landing-legacy/page.tsx` | /landing-legacy |
| `src/web/src/app/onboarding-preview/page.tsx` | /onboarding-preview |
| `src/web/src/app/pricing/page.tsx` | /pricing |
| `src/web/src/app/pricing-concept/page.tsx` | /pricing-concept |
| `src/web/src/app/privacy/page.tsx` | /privacy |
| `src/web/src/app/templates/[id]/page.tsx` | /templates/[id] |
| `src/web/src/app/templates/page.tsx` | /templates |

## Semantic operation inventory

75 native mutation entries and 17 command-facade entries are implementation entry counts, not event or successful-journey counts. The shared command helper is one native owner; facade entries refine its action. `MemberList` delegates to underlying commands and emits no duplicate lifecycle. Resolved command variants are fixed whitelists in `actions.ts`; variables, payload bodies, IDs and mutation keys do not become action names.

| Exact file | Owner | Fixed action / variant family |
|---|---|---|
| `src/web/src/app/(app)/invite/[token]/page.tsx` | InvitePage | `workspace.invite.accept` |
| `src/web/src/app/(app)/studio/new/client.tsx` | StudioOnboardingInner | `studio.agent.create` |
| `src/web/src/app/(app)/studio/new/client.tsx` | StudioOnboardingInner | `studio.onboarding.finish` |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/activity/page.tsx` | ActivityRow | `agent.task.retry` |
| `src/web/src/app/(app)/w/[slug]/agents/[id]/email/page.tsx` | AgentEmailSurface | `email.send` |
| `src/web/src/app/(app)/w/[slug]/agents/new/page.tsx` | CreateAgentPage | `agent.create` |
| `src/web/src/app/(app)/w/[slug]/calendar/page.tsx` | CalendarPage | `calendar.command` |
| `src/web/src/app/(app)/w/[slug]/home/page.tsx` | AgentCanvas | `agent.link.command` |
| `src/web/src/app/(app)/w/[slug]/settings/general-tab.tsx` | GeneralTab | `workspace.settings.command` |
| `src/web/src/app/(app)/w/[slug]/settings/instruction-tab.tsx` | InstructionTab | `workspace.instruction.save` |
| `src/web/src/app/(app)/w/[slug]/settings/members-tab.tsx` | MembersTab | `workspace.members.command` |
| `src/web/src/app/(app)/w/[slug]/settings/notification-tab.tsx` | NotificationTab | `notification.permission.request` |
| `src/web/src/app/(app)/workspaces/client.tsx` | WorkspaceListClient — source only, unmounted; runtime BLOCKED / NOT RUN | `workspace.create` |
| `src/web/src/app/c/invite/[token]/invite-accept-client.tsx` | InviteAcceptInner | `server.invite.accept` |
| `src/web/src/app/device/page.tsx` | DeviceAuthPageInner | `device.authorization.command` |
| `src/web/src/components/agent-chat/agent-chat-view.tsx` | AgentChatView | `chat.control.command` |
| `src/web/src/components/agent-edit-form.tsx` | AgentEditForm | `agent.instruction.save` |
| `src/web/src/components/community/machines/machine-list.tsx` | MachineList | `machine.command` |
| `src/web/src/components/community/machines/pair-machine-sheet.tsx` | PairMachineSheet | `machine.pair.generate` |
| `src/web/src/components/community/machines/pair-machine-sheet.tsx` | PairMachineSheet | `machine.pair.launch` |
| `src/web/src/components/community/members/add-members-dialog.tsx` | AddMembersDialog | `channel.members.add` |
| `src/web/src/components/community/members/member-list.tsx` | MemberList | `member.management.command` |
| `src/web/src/components/community/messages/create-forum-thread.tsx` | CreateForumThread | `forum.thread.create` |
| `src/web/src/components/community/messages/message-share-dialog.tsx` | MessageShareDialog | `message.export` |
| `src/web/src/components/community/messages/use-composer-controller.ts` | useComposerController | `message.compose.send` |
| `src/web/src/components/community/onboarding/community-onboarding-form.tsx` | CommunityOnboardingForm | `community.onboarding.initialize` |
| `src/web/src/components/community/onboarding/onboarding-machine-dialog.tsx` | OnboardingMachineDialog | `machine.pair.generate` |
| `src/web/src/components/community/settings/account-deletion-flow.tsx` | AccountDeletionFlow | `account.deletion.command` |
| `src/web/src/components/community/settings/user-settings.tsx` | AdvancedSettings | `cache.clear` |
| `src/web/src/components/community/social/invite-dialog.tsx` | InviteDialog | `invitation.send` |
| `src/web/src/components/community/social/invite-dialog.tsx` | InviteDialog | `invitation.copy` |
| `src/web/src/components/custom-email-form.tsx` | CustomEmailForm | `email.account.command` |
| `src/web/src/contexts/agent-context.tsx` | useAgentContext | `agent.update` |
| `src/web/src/contexts/agent-context.tsx` | useAgentContext | `agent.rail.command` |
| `src/web/src/contexts/channel-context.tsx` | useChannel | `workspace.channel.command` |
| `src/web/src/hooks/community/mutations/dm.ts` | useCreateOrGetDm | `dm.open` |
| `src/web/src/hooks/community/mutations/forum.ts` | useCreateForumThread | `forum.thread.create` |
| `src/web/src/hooks/community/mutations/forum.ts` | useUpdatePostTags | `forum.tags.update` |
| `src/web/src/hooks/community/mutations/forum.ts` | useDeleteForumThread | `forum.thread.delete` |
| `src/web/src/hooks/community/mutations/invites.ts` | useResolveOrCreateInvite | `server.invite.resolve` |
| `src/web/src/hooks/community/mutations/invites.ts` | useRevokeInvite | `server.invite.revoke` |
| `src/web/src/hooks/community/mutations/members.ts` | useMemberCommand | `server.member.command` |
| `src/web/src/hooks/community/mutations/message-memberships.ts` | usePinCommand | `message.pin.command` |
| `src/web/src/hooks/community/mutations/message-memberships.ts` | useMarkCommand | `message.mark.command` |
| `src/web/src/hooks/community/mutations/message-reactions.ts` | useReactionIntent | `message.reaction.command` |
| `src/web/src/hooks/community/mutations/messages.ts` | useEditMessage | `message.edit` |
| `src/web/src/hooks/community/mutations/messages.ts` | useSendMessage | `channel.message.send` |
| `src/web/src/hooks/community/mutations/messages.ts` | useSendDmMessage | `dm.message.send` |
| `src/web/src/hooks/community/mutations/messages.ts` | useCreateThread | `message.thread.create` |
| `src/web/src/hooks/community/mutations/messages.ts` | useMarkAllInboxRead | `inbox.read_all` |
| `src/web/src/hooks/community/mutations/messages.ts` | useDeleteMention | `mention.dismiss` |
| `src/web/src/hooks/community/mutations/notifications.ts` | useNotificationCommand | `notification.settings.command` |
| `src/web/src/hooks/community/mutations/profile.ts` | useUpdateProfile | `profile.update` |
| `src/web/src/hooks/community/mutations/profile.ts` | useUploadUserAvatar | `profile.avatar.upload` |
| `src/web/src/hooks/community/mutations/uploads.ts` | useUploadFile | `attachment.upload` |
| `src/web/src/hooks/community/use-account-sign-out.ts` | useAccountSignOut | `account.sign_out` |
| `src/web/src/hooks/community/use-billing.ts` | useBilling | `billing.redirect` |
| `src/web/src/hooks/community/use-billing.ts` | useBilling | `billing.change.cancel` |
| `src/web/src/hooks/community/use-bot-bug-report.ts` | useBotBugReport | `bot.bug_report.submit` |
| `src/web/src/hooks/community/use-bots.ts` | useBotCommand | `bot.command` |
| `src/web/src/hooks/community/use-channel-members.ts` | useChannelMemberCommand | `channel.member.command` |
| `src/web/src/hooks/community/use-community-command-mutation.ts` | useCommunityCommandMutation | `community.command` |
| `src/web/src/hooks/community/use-notification-settings.ts` | useSetBotNotificationSetting | `bot.notification.update` |
| `src/web/src/hooks/use-agent-chat.ts` | useAgentChat | `chat.command` |
| `src/web/src/hooks/use-agent-chat.ts` | useAgentChat | `chat.message.send` |
| `src/web/src/hooks/use-agent-chat.ts` | useAgentChat | `chat.session.command` |
| `src/web/src/hooks/use-application-sign-out.ts` | useApplicationSignOut | `account.sign_out` |
| `src/web/src/hooks/use-file-attachments.ts` | useFileAttachments | `attachment.prepare` |
| `src/web/src/hooks/use-message-flags.ts` | useMessageFlags | `message.flag.toggle` |
| `src/web/src/hooks/workspace/use-agent-permission-command.ts` | useAgentPermissionCommand | `agent.permission.command` |
| `src/web/src/hooks/workspace/use-inbox.ts` | useMarkAllInboxRead | `inbox.read_all` |
| `src/web/src/hooks/workspace/use-inbox.ts` | useUnflagWorkspaceMessage | `message.flag.remove` |
| `src/web/src/hooks/workspace/use-issue-command.ts` | useIssueCommand | `issue.command` |
| `src/web/src/hooks/workspace/use-runtime-command.ts` | useRuntimeCommand | `runtime.command` |
| `src/web/src/hooks/workspace/use-workspace-meetings.ts` | useWorkspaceMeetings | `meeting.command` |
| `src/web/src/hooks/community/mutations/channels.ts` | useCreateChannel | `channel.create` |
| `src/web/src/hooks/community/mutations/channels.ts` | useRenameChannel | `channel.rename` |
| `src/web/src/hooks/community/mutations/channels.ts` | useMoveChannel | `channel.move` |
| `src/web/src/hooks/community/mutations/channels.ts` | useDeleteChannel | `channel.delete` |
| `src/web/src/hooks/community/mutations/channels.ts` | useCreateCategory | `category.create` |
| `src/web/src/hooks/community/mutations/channels.ts` | useUpdateCategory | `category.update` |
| `src/web/src/hooks/community/mutations/channels.ts` | useDeleteCategory | `category.delete` |
| `src/web/src/hooks/community/mutations/channels.ts` | useReorderCategories | `category.reorder` |
| `src/web/src/hooks/community/mutations/channels.ts` | useReorderChannels | `channel.reorder` |
| `src/web/src/hooks/community/mutations/friends.ts` | useFriendCommand | `friend.command` |
| `src/web/src/hooks/community/mutations/server-rail.ts` | useServerRailCommit | `server.rail.reorder` |
| `src/web/src/hooks/community/mutations/servers.ts` | useCreateServer | `server.create` |
| `src/web/src/hooks/community/mutations/servers.ts` | useJoinServer | `server.join` |
| `src/web/src/hooks/community/mutations/servers.ts` | useLeaveServer | `server.leave` |
| `src/web/src/hooks/community/mutations/servers.ts` | useDeleteServer | `server.delete` |
| `src/web/src/hooks/community/mutations/servers.ts` | useUpdateServer | `server.update` |
| `src/web/src/hooks/community/mutations/servers.ts` | useUploadServerIcon | `server.icon.upload` |

Friend facade callees in `src/web/src/hooks/community/mutations/friends.ts`: `useSendFriendRequest`→`friend.request.send`, `useAcceptFriendRequest`→`friend.request.accept`, `useRejectFriendRequest`→`friend.request.reject`, `useRemoveFriend`→`friend.remove`, `useCancelBotFriendRequest`→`friend.request.cancel`, `useOwnerDecision`→`friend.request.approve`/`friend.request.deny`, `useBlockUser`→`user.block`, `useUnblockUser`→`user.unblock`.

Additional controlled operations outside native mutations: `app/(auth)/sign-in/{sign-in-client,social-sign-in}.tsx` records OTP/dev/social intent and result/handoff; `lib/file-download.ts` records browser initiation or resolved native save boundary; `hooks/community/use-billing.ts` records qualified checkout return; `stores/community/message-stream-store.ts` joins accepted optimistic send/upload/post acknowledgment on the original action. Other local toggles, filters, dialogs, selection and static controls have supplemental gesture coverage; their generic action does not assert a specific business result.

Action-owner inventory above is source wiring. In particular, the unmounted WorkspaceListClient is not a runtime-covered workspace.create operation; workspace and Application Provider journeys retain the reachability qualification above.

## Data and readiness boundaries

- `lib/community-db/{collections,sync,write,projections}.ts`: diagnostic WeakMaps follow the existing QueryClient/canonical owner and actual row references; no separate business cache. Unchanged restored rows keep version/source through network validation; changed fields merge origins conservatively. Selected message IDs, joined children/profiles/presence, forum threads, rail/sidebar and optimistic overlays contribute to the rendered version. Unknown contributors remain unknown/mixed.
- `lib/query-persister.ts`, `app/c/QueryProvider.tsx`, `observability/restore.ts`: async read/decode/hydration retain original generation; native hydrate must actually install the retained snapshot. Expired/buster-mismatched/unqualified snapshots and updatedAt=0 seeds do not count as restored data.
- `lib/query-client.ts`, `observability/query-observer.ts`: actual successful HTTP body values are marked network, local Query functions stay unknown, explicit WS/command scopes mark actual accepted publications. Empty message pages keep qualified window evidence through copies. Metadata is removed on collection/query/account disposal.
- `components/community/messages/message-list.tsx` and `channels/forum-view.tsx`: `observability/virtual-window.ts` intersects native Virtual item start/end with the attached scroll element's current offset/clientHeight. Mounted overscan rows do not contribute count/source/version/WS receipt. Unattached/zero-height viewports cannot certify nonempty content. Message initial positioning/interaction gates and legal empty states are retained. This is row geometry, not proof of visible text pixels or absence of arbitrary overlays. `channel-sidebar-tree-owner.tsx` is inside the existing reveal boundary. Thread opener/members/rail/sidebar are secondary except root selectors.
- `components/ui/tabs.tsx`: public Base UI panel hidden state suppresses observations for retained invisible panels. Query readiness alone cannot certify a hidden tab. Settings local preferences have generated snapshot versions but unknown storage provenance.
- `observability/regions.tsx`: render-time immutable evidence emits read and ready at React commit. RAF is an estimate of a later frame, never proof of pixels. Hidden documents report unavailable; superseded generation/URL callbacks are ignored.
- `lib/use-user-ws.ts` records transport connection, actual authentication/pong readiness, close and retry. `hooks/community/community-ws/registry.ts` emits apply outcome only after its real projection transaction completes. Original dispatch receipt flows into changed row evidence and rendered commit; `ws_duration_ms` measures dispatcher→commit, not frame-arrival/network latency.

## Privacy and delivery boundaries

Only fixed event/action/route/method/region/outcome enums, bounded numbers, release, generated diagnostic IDs and the consent-scoped opaque internal account ID leave through custom events. Absent IDs are omitted before native action span creation as well as final export. Unknown or absent HTTP methods are omitted; INTERNAL action/navigation spans do not acquire a guessed GET. Actual known CLIENT request methods, status, trace IDs and parent relationships are retained. Native metadata, spans, mirror events, web vitals and errors are rebuilt by `sanitize.ts`; collector-required SDK name/version are retained from validated native `faro-web` metadata, while arbitrary integration metadata is removed. No dynamic DOM text, message content, emails, auth tickets, query values, exception messages, raw log args or arbitrary span events/links. Original span-start session identity is required; late mirror events/spans/actions are discarded across retirement. Trace propagation is restricted to own origin and excludes the collector.

Own early queue: 256. Live actions: 64 with 30s terminal timeout. Native batch: 40/1s. Collector transport: queue 16, concurrency 2, retries 2, timeout 5s, abortable and credentials omitted. Delivery failures count failed deliveries, not guessed dropped events; retained original transport session prevents delayed failure attribution to a new session. Own queue/sink are cleared at retirement. The pinned SDK has no public signal-buffer clear method: its bounded paused buffer remains and is filtered at final `beforeSend`, while old transport is removed/aborted. Do not claim every private native buffer was physically cleared.

## Verification and remaining work

Unit/DOM contracts: route/native/facade inventory; semantic variants; concurrent mutation identity; real HTTP vs local Query origin; optimistic send→ack exactly once; immutable restored/changed/mixed/empty rows; original WS receipt retirement; qualified native hydration; sanitizer positive/negative controls; real native Faro/tracing pending import, resume/account/expiry alignment, exported first-expiry action span, concurrent single HTTP spans with distinct action parents and held batch rejection; hidden retained Base UI panels; existing thread/sidebar/navigation/auth/Blog regression contracts. Full repository terminal checks are recorded in the handoff, not inferred from a Web subset.

Correction regressions: `virtual-window.dom.test.tsx` uses installed React Virtual and the production direct DOM row adapter with controlled DOM geometry (overscan 8/5, boundary/partial rows, scroll/resize, offscreen changed WS receipt, zero/unattached viewport). `QueryProvider.observability.dom.test.tsx` mounts the actual Provider, real `createIdbPersister`/native persistence/hydration and fake IndexedDB, holding only the native request success callback. It checks admitted attribution, an executed old Provider callback after account replacement, and withdrawal/regrant during restore. `restore.test.ts` remains helper-level evidence. These DOM tests do not certify browser races or actual Grafana ingestion; native Faro transport assertions certify emitted metadata shape only.

`client-reload.dom.test.ts` starts a real native previous-document SDK session, then executes the production bootstrap against that native stored state; it requires the resumed ID/started timestamp and emitted initial session_resume. The original native test also requires fresh session_start plus import/regrant/account/expiry/HTTP-span isolation. Continuously granted same-owner documents may resume the native session; the local-only native account binding is omitted from outgoing metadata. Native public storage APIs retire stored identity at withdrawal/account changes. `blog/next.config.test.ts` and `scripts/next-config.test.ts` execute both actual configs with configured/absent public profiles and the existing Blog MDX/redirect contract; only the external dev initializer is stubbed.

First initialization aligns the current eligible unsent provisional queue to the validated native same-owner session without retiring its generation/actions. The real reload test requires an accepted early action/start/finish and business event to survive this alignment. `context.test.ts` additionally checks original request ownership/timestamps, and rejects alignment after sink installation, a different queued identity or retirement. Initial SDK import has no installed action-span factory yet; these early action events do not certify an exported action span. Actual consent/account/expiry boundaries still retire prior work, and final sanitizer accepts only the current native session.

`client-account-reload.dom.test.tsx` executes actual early instrumentation-client → actual QueryProvider, against a real previous same-account native SDK document. Its follow-up regression holds the real tracing import until after the eligible Provider and the former fixed 1500ms wait, then waits for the required actual session_resume export. This reproduces an asynchronous export race, not a uniquely established cause of the historical Ubuntu failure. Account-owned routes wait for first Provider identity; first confirmation preserves resume eligibility, while true owner changes retire it. No telemetry-only auth request is added. Public community invite uses the existing module-plan classification.

`auth-client-observability.dom.test.tsx` executes actual BetterAuth/public sign-out, the Application Provider and sign-out facade, with real native Faro and a controlled fetch backend. Failed logout retains the owner/session; a held A completion after real sign-in and Provider replacement by B cannot retire B; successful current B logout clears user metadata and creates anonymous identity. The existing IO owner check and captured diagnostic identity revision guard the actual success boundary. Native user metadata changes before new session lifecycle metadata. This is integration evidence, not a browser logout or received collector result.

Both existing account Providers also invoke their captured diagnostic retirement closure when the current existing SDK viewer is confirmed anonymous, including after business ownership has already retired. Pending/error or a different current viewer cannot certify anonymity; an old owner/revision cannot clear the newer owner. `provider-auth-null.dom.test.tsx` mounts both actual Providers with controlled auth input and real Faro, checking pending/error, delayed A against current B, then confirmed current null and emitted anonymous metadata. The real BetterAuth integration additionally invokes the public SDK signOut outside the application wrapper and requires Provider-driven anonymous metadata. No additional authentication request is introduced.

| Evidence dimension | Handoff state | Owner / next proof |
|---|---|---|
| Local unit/DOM + normal root hooks | first candidate terminal checks supplied; correction terminal checks in the follow-up handoff | Samara; checks are tied to their source, not runtime acceptance |
| Main + independent Blog exact-release production build/journeys | independent d185 journeys reported; follow-up correction builds/journeys pending | Madox; retain d185 build receipts and compile the same public profile plus the new full SHA into both new builds |
| Local Workers/D1/WS product journeys | d185 scoped community UI/API/DO results reported; raw browser WS proof and live D1 qualifications remain separate; native upload and non-community entry BLOCKED | Madox; preserve original failures and backend boundaries; rerun the correction checklist on the new source |
| Actual Grafana ingestion/session/actions/spans | historical d9 HTTP400 retained; d185 HTTP202 and bounded received main/Blog/session/navigation/DM/viewport samples qualified independently; d185 INTERNAL span absent-ID/guessed-method defect observed, follow-up source has local native-export regressions only | Madox + Jarvis; new full SHA, actual session/action/trace IDs, UTC window and received samples must verify the correction; HTTP202 alone is not complete ingestion proof |
| Workspace list/create and Application Provider real journey | BLOCKED / NOT RUN; unmounted list/create source, no verified existing workspace fixture | keep source wiring and actual entry reachability separate; no hidden mutation or retired entry revival |
| CI37341839062 | terminal FAIL: Ubuntu session_resume and UI shard 9 resize; both gates FAIL; coverage qualification incomplete | retain original CI; new candidate remote CI and exact composer occupancy runtime remain pending |
| Cloudflare execution/ray/log/backend same-trace correlation | NOT RUN | requires the same candidate deployed to Cloudflare; local --local is not this proof |
| Native OS internals / Auth HTML / external OAuth or Stripe page internals | B capability boundary | controlled in-app handoff/result only; no capture on ticket-bearing Auth HTML |
| Arbitrary SSR/RSC per-view cache origin / Resource Timing cache hit | B unknown | no owner evidence; transferSize=0 is not cache proof |

Grafana native session, action, error, performance and trace views are the first inspection path. Custom dashboards/queries will be added only if those fail the agreed inspection needs; d185 received field paths have been sampled for the stated windows; unsampled journeys and the follow-up correction retain their own pending qualifications.
