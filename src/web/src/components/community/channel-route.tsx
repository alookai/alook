"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channel-header"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton } from "@/components/community/composer"
import { ForumViewSkeleton } from "@/components/community/forum-view"
import { ForumSurface } from "@/components/community/forum-surface"
import { TextChannelSurface, type TextChannelMemberPanelProps } from "@/components/community/text-channel-surface"
import { MessageChannelController } from "@/components/community/message-channel-controller"
import { ChannelShell } from "@/components/community/channel-shell"
import type { NewForumThread } from "@/components/community/create-forum-thread"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { MessageContextSheet } from "@/components/community/message-context-sheet"
import { ThreadOpener } from "@/components/community/thread-opener"
import { AddMembersDialog } from "@/components/community/add-members-dialog"
import type { RightPanel, OpenProfile, Role } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import { isForum as isForumType, USE_SERVER_DEFAULT } from "@alook/shared"
import { resolveRowPresence } from "@/lib/community/presence"
import { setLastChannel } from "@/lib/community/last-channel"
import { makeUserNameResolver } from "@/lib/community/display-name"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import {
  useCurrentChannelId,
  useUiHandlers,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useChannelMembers, useAddableMembers, useAddChannelMember, useRemoveChannelMember } from "@/hooks/community/use-channel-members"
import { useAddThreadParticipant, useRemoveThreadParticipant } from "@/hooks/community/use-thread-participants"
import { useMessage } from "@/hooks/community/use-message"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useOnlineUserIds, useCommunityWsStore } from "@/stores/community/ws"
import {
  useEditMessage,
  useCreateForumThread,
  useUpdatePostTags,
  useDeleteForumThread,
  useSetMemberRole,
  useKickMember,
  useSetChannelNotif,
} from "@/hooks/community/mutations"

/**
 * /c/channels/:serverId/:channelId
 *
 * - Forum channel: ForumView
 * - Text channel: MessageList + Composer + right panels
 * - Child thread opened via URL: child-channel view (breadcrumb + list)
 */
export function ChannelRoute({ serverParam, channelId }: { serverParam: string; channelId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(serverParam)
  // Remember this as the server's last-opened channel (per-browser navigation
  // memory) so re-entering the server restores here instead of the default.
  // Pure localStorage write; failures are swallowed in the helper.
  useEffect(() => {
    setLastChannel(serverId, channelId)
  }, [serverId, channelId])
  // Cross-channel "jump to message" target, captured ONCE at mount from `?msg=`.
  // `ChannelView` is keyed by `serverId/channelId`, so a fresh jump remounts and
  // re-reads this. The param is stripped from the URL right after (below) so a
  // refresh/back doesn't re-trigger the jump; this frozen copy still drives the
  // anchor + scroll for this mount.
  const [jumpTargetId] = useState<string | null>(() => searchParams.get("msg"))
  const bp = useBreakpoint()
  const currentUser = useCurrentUser()
  const uiHandlers = useUiHandlers()
  const currentChannelId = useCurrentChannelId()
  const routeModel = useChannelRouteModel(serverId, serverParam, channelId)
  const {
    server: currentServer,
    channel: channelInServer,
    currentChannelMeta,
    isForum,
    isChild: isChildChannel,
    isForumPostChild,
    isNotifyUnit,
  } = routeModel
  const membersHook = useServerMembers(serverId)
  const onlineUserIds = useOnlineUserIds()
  const userStatuses = useCommunityWsStore((s) => s.userStatuses)
  // Members enriched with presence — used by the message list's typingUsers
  // resolution and the panel roster to render the correct dot.
  const members = useMemo(
    () =>
      membersHook.members.map((m) => {
        const liveStatus = userStatuses.get(m.userId)
        return {
          ...m,
          status: resolveRowPresence(m, onlineUserIds, currentUser.id),
          statusEmoji: liveStatus ? liveStatus.emoji : m.statusEmoji,
          statusText: liveStatus ? liveStatus.text : m.statusText,
        }
      }),
    [membersHook.members, onlineUserIds, currentUser.id, userStatuses],
  )
  const { message: forumPostOpener, isLoading: forumPostOpenerLoading } = useMessage(
    isForumPostChild ? currentChannelMeta?.parentMessageId : null,
  )
  // A thread (child channel rooted on a `parentMessageId`) and a forum post
  // (child channel with no `parentMessageId`) are both the NOTIFICATION
  // dimension: their drawer shows PARTICIPANTS (not an access audience), their
  // add button adds a PARTICIPANT, and their @-mention pool is the parent
  // channel/forum's members. Since every child channel is one or the other,
  // `isNotifyUnit === isChildChannel` — a load-stable value that doesn't flip
  // while `currentChannelMeta` hydrates. The thread/post distinction affects
  // only labels, handled inline, so a single flag drives all behavior here.

  // Local filter for the private-channel Members drawer (the channel audience is
  // small, so search is client-side — no scoped search endpoint).
  const [memberQuery, setMemberQuery] = useState("")
  // Whether the manage-members dialog is open (Add button in the private drawer).
  const [manageMembersOpen, setManageMembersOpen] = useState(false)

  // Is the current channel (or its anchor, for a thread) inside a PRIVATE
  // category? Drives the Members drawer's data source: private → the channel
  // audience via `useChannelMembers`; public → the server roster. The server
  // re-checks privacy anyway (`requireChannelAccess`), so an over-eager `true`
  // only risks calling the channel endpoint when it wasn't needed — safe.
  const currentChannelPrivate = useMemo(() => {
    const cats = currentServer?.categories ?? []
    // Child-thread privacy is governed by the anchor channel's category.
    const anchorId = isChildChannel
      ? (currentChannelMeta?.parentChannelId ?? channelId)
      : channelId
    const cat = cats.find((c) => c.channels.some((ch) => ch.id === anchorId))
    return !!cat?.private
  }, [currentServer, isChildChannel, currentChannelMeta, channelId])
  // Members drawer read: `/members` for BOTH a private channel and a notify
  // unit (thread/post). For a notify unit `/members` resolves the NOTIFY
  // (participant) set — same people the old `/participants` read returned — but
  // in the unified `MappedMember` shape (status/role/isCreator), so a post's
  // panel matches a channel's. A public top-level channel still uses the server
  // roster (`members`), so the hook stays gated to private-or-notify-unit.
  const channelMembersHook = useChannelMembers(channelId, isNotifyUnit || (currentChannelPrivate && !isNotifyUnit))
  const removeThreadParticipantMut = useRemoveThreadParticipant(channelId)
  const addThreadParticipantMut = useAddThreadParticipant(channelId)
  // Top-level channel/forum add-picker source + mutations (add: any member).
  // W-LAZY (necessity plan): the composed candidate pool feeds ONLY the "add
  // members" dialog, so build it only while that dialog is open — not eagerly
  // on channel open. `manageMembersOpen` gates both the dialog's render and
  // this fetch, so opening the dialog triggers the fetch and a plain channel
  // switch never does.
  const addableChannelMembers = useAddableMembers(
    serverId,
    channelId,
    manageMembersOpen && currentChannelPrivate && !isNotifyUnit,
  )
  const addChannelMemberMut = useAddChannelMember(channelId)
  const removeChannelMemberMut = useRemoveChannelMember(channelId)
  // Notify-unit add-picker source = the parent channel/forum's roster (minus
  // current participants + self, computed at dialog build). A thread's parent is
  // its channel; a post's parent is its forum. Enabled for both.
  const threadParentId = isNotifyUnit ? (currentChannelMeta?.parentChannelId ?? null) : null
  const parentChannelMembersHook = useChannelMembers(threadParentId ?? "", !!threadParentId)

  // Members shown in the right-panel Members drawer:
  //   - thread → its notify participants (mapped to the roster shape).
  //   - private channel/post → the resolved channel audience (locally filtered).
  //   - public → the server roster.
  // All enriched with live presence for the correct dot.
  const panelMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase()
    const withPresence = (m: {
      userId: string; name: string; discriminator: string; avatar: string
      statusEmoji?: string | null; statusText?: string | null
      isCreator?: boolean; source?: "explicit" | "inherited" | "admin"
    }) => {
      const liveStatus = userStatuses.get(m.userId)
      return {
        id: m.userId,
        userId: m.userId,
        name: m.name,
        discriminator: m.discriminator,
        avatar: m.avatar,
        sub: "",
        role: "member" as const,
        status: resolveRowPresence(m, onlineUserIds, currentUser.id),
        statusEmoji: liveStatus ? liveStatus.emoji : (m.statusEmoji ?? null),
        statusText: liveStatus ? liveStatus.text : (m.statusText ?? ""),
        isCreator: m.isCreator,
        source: m.source,
      }
    }
    const matches = (name: string, disc?: string | null) =>
      !q || name.toLowerCase().includes(q) || (disc ?? "").toLowerCase().includes(q)

    if (isNotifyUnit) {
      // Notify unit → the participant set, now read from `/members` in the
      // unified shape (`isCreator` computed server-side against the unit's
      // author). Participants are ALL real, creator-removable rows, so drop
      // `source` to `undefined` — the notify set has no explicit/inherited/admin
      // distinction, and MemberList treats `source === undefined` as removable
      // (the same behavior the old `/participants` read gave).
      return channelMembersHook.members
        .filter((m) => matches(m.name, m.discriminator))
        .map((m) => withPresence({ ...m, source: undefined }))
    }
    if (!currentChannelPrivate) return members
    return channelMembersHook.members
      .filter((m) => matches(m.name, m.discriminator))
      .map((m) => withPresence(m))
  }, [
    isNotifyUnit,
    currentChannelPrivate,
    members,
    channelMembersHook.members,
    memberQuery,
    onlineUserIds,
    currentUser.id,
    userStatuses,
  ])

  // Roster passed to the @-mention popover — filters the viewer out.
  // `members` still includes the viewer for the roster / typing lookup; only the
  // composer needs to drop self (you can't @-mention yourself).
  //
  // Scoping (nested-membership model): in a private channel/post the popover
  // lists only that unit's members; in a thread it lists the parent channel's
  // members (the channel-members endpoint climbs a thread to its anchor). Public
  // channels keep the whole-server roster. Uses `channelMembersHook.members`
  // (unfiltered by the drawer's search box), enriched with live presence to
  // match the server-roster path.
  const composerMembers = useMemo(() => {
    if (!currentChannelPrivate) {
      return members.filter((m) => m.userId !== currentUser.id)
    }
    // Private unit: scope to the unit's roster. A thread/post has NO roster of
    // its own — its `channelMembersHook` is disabled — so its mention candidates
    // are the parent channel/forum's members (the same source the add-participant
    // dialog uses). A private top-level channel/forum uses its own roster.
    const scopedRoster = isNotifyUnit ? parentChannelMembersHook.members : channelMembersHook.members
    return scopedRoster
      .filter((m) => m.userId !== currentUser.id)
      .map((m) => {
        const liveStatus = userStatuses.get(m.userId)
        return {
          ...m,
          status: resolveRowPresence(m, onlineUserIds, currentUser.id),
          statusEmoji: liveStatus ? liveStatus.emoji : m.statusEmoji,
          statusText: liveStatus ? liveStatus.text : m.statusText,
        }
      })
  }, [
    currentChannelPrivate,
    isNotifyUnit,
    members,
    channelMembersHook.members,
    parentChannelMembersHook.members,
    onlineUserIds,
    currentUser.id,
    userStatuses,
  ])

  // `/`-autocomplete candidates for both Composer call sites below — single
  // server, so no directory hook needed here (see `me/[dmId]/page.tsx` for
  // the cross-server DM case).
  const channelRefCandidates = useMemo(() => {
    const allChannels = currentServer?.categories?.flatMap((c) => c.channels) ?? []
    return allChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      serverId,
      serverName: currentServer?.name ?? "",
    }))
  }, [currentServer, serverId])
  const messageFeed = useChannelMessageFeed({
    channelId: isChildChannel ? channelId : null,
    serverId,
    viewerUserId: currentUser.id,
    isChildChannel,
    anchorMessageId: jumpTargetId,
  })
  const messagesLoading = messageFeed.isLoading
  const notifs = useNotificationSettings()
  const channelNotif = notifs.channel
  const { mutateAsync: editMessageAsync } = useEditMessage()
  const createForumThreadMut = useCreateForumThread()
  const updatePostTagsMut = useUpdatePostTags()
  const deleteForumThreadMut = useDeleteForumThread()
  const setMemberRoleMut = useSetMemberRole()
  const kickMemberMut = useKickMember()
  const setChannelNotifMut = useSetChannelNotif()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])

  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const [localName, setLocalName] = useState<string | null>(null)

  // Strip `?msg=` from the URL right after mount so a refresh/back doesn't
  // re-trigger the jump. The frozen `jumpTargetId` still seeds the mounted
  // message controller for this mount; this only cleans the address.
  useEffect(() => {
    if (!jumpTargetId) return
    router.replace(`/c/channels/${serverParam}/${channelId}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this mount's jump
  }, [])

  useEffect(() => {
    setRightPanel(null)
    setLocalName(null)
    setMemberQuery("")
    setManageMembersOpen(false)
  }, [channelId])

  // Find the channel name
  const channelName = useMemo(() => {
    return resolveChannelDisplayName({
      localName,
      forumPostTitle: isForumPostChild ? forumPostOpener?.content : null,
      topLevelName: channelInServer?.name,
      childChannelName: isForumPostChild ? null : currentChannelMeta?.name,
      forumListName: null,
      threadListName: null,
      fallback: isForumPostChild ? "Post" : "channel",
    })
  }, [localName, isForumPostChild, forumPostOpener, channelInServer, currentChannelMeta])

  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  const enterThread = useCallback((id: string) => {
    // No eager read PUT here — the thread page's `useEagerChannelRead` fires it
    // on mount AFTER its read-state snapshot latches, so the "New" divider
    // still anchors to the pre-open pointer. A PUT here would race the snapshot.
    router.push(`/c/channels/${serverParam}/${id}`)
  }, [router, serverParam])

  const openProfile = useCallback<OpenProfile>((name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }, [uiHandlers])

  // Reference-stable across renders. MUST depend on the RAW roster
  // (`membersHook.members`), NOT the presence-enriched `members` (line ~110):
  // `makeUserNameResolver` only reads id/name/email, never presence, yet the
  // enriched array gets a new identity on every presence/status tick. Keying
  // this resolver on it re-created it on every tick and busted every memoized
  // message row (react-scan measured MessageImpl re-rendering with
  // `props:[resolveUserName]` — ~1/3 of the switch re-render storm). The raw
  // roster's identity changes only when membership/names genuinely change.
  const resolveUserName = useMemo(
    () => makeUserNameResolver(membersHook.members),
    [membersHook.members],
  )

  const createForumThread = useCallback(async (post: NewForumThread) => {
    const data = await createForumThreadMut.mutateAsync({
      nonce: post.nonce,
      channelId,
      name: post.name,
      content: post.content,
      attachments: post.attachments,
      mentionType: post.mentionType,
    })
    // A post is its own child channel — open it, same as clicking a post row.
    enterThread(data.threadId)
  }, [channelId, createForumThreadMut, enterThread])

  const myRole = members.find((m) => m.userId === currentUser.id)?.role
  // The unit's creator (thread/channel/post) — drives the manage-context
  // creator rules. For a thread the id lives on `currentChannelMeta`; for a
  // top-level channel/post it's on the channel row in the server tree.
  const unitCreatorId = isChildChannel
    ? currentChannelMeta?.creatorId
    : channelInServer?.creatorId
  const viewerIsUnitCreator = !!unitCreatorId && unitCreatorId === currentUser.id
  // The drawer's manage affordance:
  //   - thread/post (notify unit) → add PARTICIPANTS (any participant); rows
  //     right-click to leave/remove.
  //   - private top-level channel/forum → add MEMBERS (any member); rows
  //     right-click to leave (self) / remove (creator).
  // Public top-level channels/forums: no manage button (everyone can access).
  const showManageButton = isNotifyUnit || currentChannelPrivate
  // Whether the drawer is on a scoped (participant/audience) source vs the
  // paginated server roster.
  const scopedDrawer = isNotifyUnit || currentChannelPrivate
  // Row right-click Leave/Remove context. Remove is creator-only on every unit;
  // the wired mutation differs by unit (participant vs channel-member).
  const manageContext = scopedDrawer
    ? {
        viewerUserId: currentUser.id,
        viewerIsCreator: viewerIsUnitCreator,
        unitLabel: currentChannelMeta?.name ?? channelName,
        // Return the promise so the confirm dialog can show a loading state and
        // surface errors from ONE place (MemberList's confirm catch).
        onLeave: (userId: string) =>
          (isNotifyUnit ? removeThreadParticipantMut : removeChannelMemberMut).mutateAsync(userId),
        onRemove: (userId: string) =>
          (isNotifyUnit ? removeThreadParticipantMut : removeChannelMemberMut).mutateAsync(userId),
      }
    : undefined
  const memberPanelProps: TextChannelMemberPanelProps = {
    members: panelMembers,
    membersLoading: isNotifyUnit
      ? channelMembersHook.isLoading
      : currentChannelPrivate ? channelMembersHook.isLoading : membersHook.loading,
    membersLoadingMore: scopedDrawer ? false : membersHook.loadingMore,
    membersHasMore: scopedDrawer ? false : membersHook.hasMore,
    onLoadMoreMembers: scopedDrawer ? undefined : membersHook.loadMore,
    // Scoped drawer: local filter (small set). Public: server search.
    onSearchMembers: scopedDrawer ? setMemberQuery : membersHook.searchMembers,
    onAddMember: showManageButton ? () => setManageMembersOpen(true) : undefined,
    manageContext,
    myRole,
    onSetRole: (memberId: string, role: Role) => {
      setMemberRoleMut.mutate({ serverId, memberId, role }, {
        onSuccess: () => toast("Role updated"),
        onError: (e) => toastApiError(e, "Failed to update role"),
      })
    },
    // Return the promise (and success toast) so MemberList's confirm dialog can
    // show a loading state; the error is surfaced from MemberList's catch (one
    // toast source).
    onKickMember: (memberId: string) =>
      kickMemberMut.mutateAsync({ serverId, memberId }).then(() => toast("Member kicked")),
  }

  // Add-members dialog (shared), mounted when the drawer's Add button fires.
  //   - thread/post (notify unit) → candidates = parent channel/forum members
  //     not yet participating; onAdd = add participant.
  //   - private top-level channel/forum → candidates = server members not in the
  //     unit; onAdd = add channel member (targets `channelId` directly).
  // The current-member list + leave/remove live in the drawer row right-click
  // menu (`manageContext`), not here.
  const manageMembersDialog = (() => {
    if (!manageMembersOpen) return null
    if (isNotifyUnit) {
      const participantIds = new Set(channelMembersHook.members.map((m) => m.userId))
      const candidates = parentChannelMembersHook.members
        .filter((m) => !participantIds.has(m.userId) && m.userId !== currentUser.id)
        .map((m) => ({ userId: m.userId, name: m.name ?? null, avatar: m.avatar }))
      return (
        <AddMembersDialog
          title={`Add participants to /${currentChannelMeta?.name ?? channelName}`}
          subtitle="Added people are notified of new replies. Anyone with access can already read it."
          candidates={candidates}
          onAdd={(userId) => addThreadParticipantMut.mutateAsync(userId)}
          onClose={() => setManageMembersOpen(false)}
        />
      )
    }
    const candidates = addableChannelMembers.members.map((m) => ({
      userId: m.userId,
      name: m.name ?? null,
      avatar: m.avatar,
    }))
    return (
      <AddMembersDialog
        title={`Add members to /${channelName}`}
        subtitle="Added members can see and post here."
        candidates={candidates}
        onAdd={(userId) => addChannelMemberMut.mutateAsync(userId)}
        onClose={() => setManageMembersOpen(false)}
      />
    )
  })()

  // ForumSurface owns its feed loading state. Channel hydration only waits on
  // the text/thread message controller for non-forum surfaces.
  const bodyLoading = isChildChannel ? messagesLoading : false
  const channelHydrated =
    currentChannelId === channelId &&
    routeModel.routeHydrated &&
    !bodyLoading &&
    (!isForumPostChild || !forumPostOpenerLoading)
  if (!channelHydrated) {
    if (isForum) {
      return (
        <>
          <ChannelHeaderSkeleton onBack={bp === "mobile" ? goBack : undefined} />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ForumViewSkeleton />
          </main>
        </>
      )
    }
    return (
      <>
        <ChannelHeaderSkeleton onBack={bp === "mobile" ? goBack : undefined} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
            `key={channelId}` MUST match the hydrated branches' key below —
            verified empirically (react-test-renderer) that a mismatched key
            (this branch had none before) is what causes React to treat this
            and the hydrated-branch `<MessageList>` as different component
            identities, forcing a full unmount/remount instead of a props
            update on one instance when `channelHydrated` flips true. With
            matching keys, this works correctly even though this early
            `return` and the hydrated branches' `return` produce
            structurally different JSX trees — React's reconciliation only
            needs the position + type + key to line up.
          */}
          <MessageList key={channelId} channel="" messages={[]} loading={true} onOpenThread={() => { }} />
          <ComposerSkeleton />
        </main>
      </>
    )
  }

  // ── Child channel view (forum post / thread opened via URL) ─────────────
  if (isChildChannel) {
    const parentId = currentChannelMeta?.parentChannelId
    const parentMessageId = currentChannelMeta?.parentMessageId ?? null
    const allChannels = currentServer?.categories?.flatMap((c) => c.channels) ?? []
    const parentChannel = parentId ? allChannels.find((ch) => ch.id === parentId) : null
    const parentName = parentChannel?.name ?? "channel"
    const parentIsForum = isForumType(parentChannel?.type)
    const opener = parentMessageId && !parentIsForum ? (
      <ThreadOpener
        parentMessageId={parentMessageId}
        onOpenProfile={openProfile}
        onPreviewImage={(url) => uiHandlers.previewImage?.(url)}
        onDownloadFile={(url) => {
          const a = document.createElement("a")
          a.href = url
          a.download = url.split("/").pop() ?? "file"
          a.click()
        }}
        onJump={
          parentId
            ? () =>
                router.push(
                  `/c/channels/${serverParam}/${parentId}?msg=${parentMessageId}`,
                )
            : undefined
        }
      />
    ) : undefined
    return (
      <MessageChannelController
        channelId={channelId}
        serverId={serverId}
        serverParam={serverParam}
        channelName={channelName}
        viewer={currentUser}
        anchorMessageId={jumpTargetId}
        feed={messageFeed}
        uiHandlers={uiHandlers}
        onOpenThread={() => {}}
        onOpenPinned={() => setRightPanel("pinned")}
        resolveUserName={resolveUserName}
      >
        {(controller) => <ChannelShell
        header={<ChannelHeader
          channel={parentName}
          forum={parentIsForum}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          notifLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
          onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l }, {
            onError: (e) => toastApiError(e, "Failed to update notification level"),
          })}
          onBack={bp === "mobile" ? () => router.back() : undefined}
          server={bp === "mobile" && currentServer ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon } : undefined}
          tools={{ threads: false }}
          breadcrumb={{
            label: channelName,
            titleRename: parentIsForum,
            onNavigateBack: () => { if (parentId) router.push(`/c/channels/${serverParam}/${parentId}`); else router.back() },
            onRename: parentIsForum && parentId && parentMessageId && currentChannelMeta?.creatorId === currentUser.id
              ? async (name) => {
                try {
                  await editMessageAsync({
                    serverId,
                    channelId: parentId,
                    messageId: parentMessageId,
                    content: name,
                    forumChannelId: parentId,
                  })
                } catch (e) {
                  toastApiError(e, "Failed to edit post")
                  throw e
                }
              }
              : !parentIsForum && canManageServer(myRole) ? async (name) => {
              try {
                await apiFetch(`/api/community/channels/${channelId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name }),
                })
                setLocalName(name)
              } catch (e) {
                toastApiError(e, "Failed to rename")
                throw e
              }
            } : undefined,
          }}
        />}
        body={<main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList
            key={channelId}
            channel={channelName}
            messages={controller.feed.messages}
            loading={messagesLoading}
            pinnedIds={controller.pinnedIds}
            newDividerBefore={controller.feed.newDividerBefore}
            typingUsers={controller.typingUsers}
            onOpenThread={() => { }}
            {...controller.threadActions}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            scrollToMessageId={controller.scrollTargetId}
            hero={opener}
            onScrollRoot={controller.feed.setScrollRootEl}
            viewerUserId={currentUser.id}
            // Same gate as the top-level channel view: hold the mount-time
            // scroll until the read snapshot resolves and its anchor is loaded,
            // so a child thread opens on the "New" divider too.
            initialScrollReady={!controller.feed.readSnapshotFetching && controller.feed.anchorInCache}
            onScrollTargetConsumed={controller.consumeScrollTarget}
            hasMore={controller.feed.hasMoreOlder}
            isFetchingOlder={controller.feed.isFetchingOlder}
            onLoadOlder={controller.feed.fetchOlder}
            hasMoreNewer={controller.feed.hasMoreNewer}
            isFetchingNewer={controller.feed.isFetchingNewer}
            onLoadNewer={controller.feed.fetchNewer}
            onJumpToPresent={controller.feed.jumpToPresent}
            unreadCount={controller.feed.unreadCount}
            onOpenContextSheet={controller.openContextSeq}
          />
          <div data-onboarding-target="channel-composer" className="shrink-0">
            <Composer
              channel={channelName}
              context="thread"
            members={composerMembers}
            onSearchMembers={membersHook.searchMembers}
            channelRefCandidates={channelRefCandidates}
            sendContract="accepted"
            onAcceptSend={controller.acceptMessage}
            onTyping={controller.handleTyping}
            replyingTo={controller.replyTo?.authorName}
            onCancelReply={() => controller.setReplyTo(null)}
            autoFocus={bp !== "mobile"}
              draftKey={`${serverId}/${channelId}`}
            />
          </div>
        </main>}
        panels={rightPanel && (
          <CommunityPanelSheet
            open
            onOpenChange={(v) => { if (!v) setRightPanel(null) }}
            kind={rightPanel}
            {...memberPanelProps}
            pinned={controller.feed.pinned}
            pinnedLoading={controller.feed.pinnedLoading}
            searchResults={controller.searchResults}
            searchQuery={controller.searchQuery}
            threads={controller.feed.threads}
            threadsLoading={controller.feed.threadsLoading}
            onOpenThread={enterThread}
            onJumpToMessage={controller.jumpToSeq}
            onSearch={controller.search}
            onOpenProfile={openProfile}
          />
        )}
        dialogs={<>{manageMembersDialog}<MessageContextSheet
          open={controller.contextTarget !== null}
          onOpenChange={(v) => { if (!v) controller.setContextTarget(null) }}
          channelId={controller.contextTarget?.channelId ?? channelId}
          channelLabel={controller.contextTarget?.label}
          targetSeq={controller.contextTarget?.seq ?? null}
          pinnedIds={controller.pinnedIds}
          onOpenContextSheet={controller.openContextSeq}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          onReply={controller.onSheetReply}
        /></>}
        />}
      </MessageChannelController>
    )
  }

  // ── Forum view ──────────────────────────────────────────────────────────
  if (isForum) {
    const canManage = canManageServer(myRole)
    return (
      <ChannelShell
        header={<ChannelHeader
          channel={channelName}
          forum
          rightPanel={rightPanel}
          onToggle={togglePanel}
          notifLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
          onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l }, {
            onError: (e) => toastApiError(e, "Failed to update notification level"),
          })}
          onBack={bp === "mobile" ? goBack : undefined}
          server={bp === "mobile" && currentServer ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon } : undefined}
          tools={{ threads: false, pinned: false }}
        />}
        body={<main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ForumSurface
            serverId={serverId}
            forumChannelId={channelId}
            members={composerMembers}
            onSearchMembers={membersHook.searchMembers}
            onOpenPost={enterThread}
            onCreatePost={createForumThread}
            canEditPostTags={(post) => canManage || post.authorId === currentUser.id}
            savingTagsFor={updatePostTagsMut.isPending ? updatePostTagsMut.variables?.threadId ?? null : null}
            onEditPostTags={(post, tags) => {
              updatePostTagsMut.mutate(
                { forumChannelId: channelId, threadId: post.id, openerMessageId: post.openerMessageId, tags },
                { onError: (e) => toastApiError(e, "Failed to update tags") },
              )
            }}
            canDeletePost={(post) => canManage || post.authorId === currentUser.id}
            deletingPost={deleteForumThreadMut.isPending ? deleteForumThreadMut.variables?.threadId ?? null : null}
            onDeletePost={(post) => {
              deleteForumThreadMut.mutate(
                { forumChannelId: channelId, threadId: post.id },
                { onError: (e) => toastApiError(e, "Failed to delete post") },
              )
            }}
          />
        </main>}
        panels={rightPanel && (
          <CommunityPanelSheet
            open
            onOpenChange={(v) => { if (!v) setRightPanel(null) }}
            kind={rightPanel}
            {...memberPanelProps}
            pinned={[]}
            searchResults={[]}
            threads={[]}
            onOpenThread={enterThread}
            onOpenProfile={openProfile}
          />
        )}
        dialogs={manageMembersDialog}
      />
    )
  }

  // ── Standard channel view ───────────────────────────────────────────────
  return (
    <TextChannelSurface
      channelId={channelId}
      serverId={serverId}
      serverParam={serverParam}
      channelName={channelName}
      viewer={currentUser}
      anchorMessageId={jumpTargetId}
      headerServer={bp === "mobile" && currentServer
        ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon }
        : undefined}
      notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
      onSetNotificationLevel={(level) => setChannelNotifMut.mutate({ channelId, level }, {
        onError: (error) => toastApiError(error, "Failed to update notification level"),
      })}
      onBack={bp === "mobile" ? goBack : undefined}
      composerMembers={composerMembers}
      onSearchComposerMembers={membersHook.searchMembers}
      channelRefCandidates={channelRefCandidates}
      memberPanelProps={memberPanelProps}
      manageMembersDialog={manageMembersDialog}
      uiHandlers={uiHandlers}
      onOpenThread={enterThread}
      onOpenProfile={openProfile}
      resolveUserName={resolveUserName}
    />
  )
}
