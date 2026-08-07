"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channel-header"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton, type SendAttachment } from "@/components/community/composer"
import { ForumViewSkeleton } from "@/components/community/forum-view"
import { ForumSurface } from "@/components/community/forum-surface"
import { TextChannelSurface } from "@/components/community/text-channel-surface"
import { ChannelShell } from "@/components/community/channel-shell"
import type { NewForumThread } from "@/components/community/create-forum-thread"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { MessageContextSheet } from "@/components/community/message-context-sheet"
import { ThreadOpener } from "@/components/community/thread-opener"
import { AddMembersDialog } from "@/components/community/add-members-dialog"
import type { RightPanel, Msg, OpenProfile, Role } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import type { MentionType } from "@alook/shared"
import { isForum as isForumType, deriveThreadName, USE_SERVER_DEFAULT } from "@alook/shared"
import { resolveRowPresence } from "@/lib/community/presence"
import { setLastChannel } from "@/lib/community/last-channel"
import { makeUserNameResolver } from "@/lib/community/display-name"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import { avatarInitial } from "@/lib/community/avatar"
import {
  useCommunityStore,
  useCurrentChannelId,
  useUiHandlers,
  useTypingUsersForScope,
  useTypingNamesForScope,
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
import { useMessageStreamStore } from "@/stores/community/message-stream"
import {
  useSendMessage,
  useToggleReactionApi,
  usePinMessage,
  useUnpinMessage,
  useToggleMark,
  useEditMessage,
  useCreateThread,
  useCreateForumThread,
  useUpdatePostTags,
  useDeleteForumThread,
  useSetMemberRole,
  useKickMember,
  useSetChannelNotif,
  useUploadFile,
  zipUploadResultsWithDimensions,
  toAttachmentVm,
  sendNonce,
  tempMessageId,
  type UploadedAttachment,
} from "@/hooks/community/mutations"
import {
  communityWsSendTyping,
  communityWsResetTypingThrottle,
} from "@/hooks/community/use-community-ws"

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
    parent: parentChannelInServer,
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
  const {
    messages,
    isLoading: messagesLoading,
    hasMoreOlder: hasMoreMessages,
    hasMoreNewer: hasMoreNewerMessages,
    isFetchingOlder: isFetchingOlderMessages,
    isFetchingNewer: isFetchingNewerMessages,
    fetchOlder: fetchOlderMessages,
    fetchNewer: fetchNewerMessages,
    jumpToPresent,
    latestSeq,
    readSnapshot,
    readSnapshotFetching,
    newDividerBefore,
    anchorInCache,
    unreadCount,
    setScrollRootEl,
    threads,
    threadsLoading,
    pinned,
    pinnedLoading,
  } = messageFeed
  const notifs = useNotificationSettings()
  const channelNotif = notifs.channel
  const typingUsers = useTypingUsersForScope(`ch:${channelId}`)
  const typingNames = useTypingNamesForScope(`ch:${channelId}`)

  // Mutations
  // Destructure the reference-STABLE mutation methods (TanStack binds
  // `.mutate`/`.mutateAsync` in the observer, but returns a NEW wrapper object
  // every render — depending on the whole object would bust every downstream
  // useMemo/useCallback every render). See doSend / messageActions deps.
  const { mutateAsync: sendMessageAsync } = useSendMessage()
  const toggleReactionApi = useToggleReactionApi()
  const { mutate: pinMessageMutate } = usePinMessage()
  const { mutate: unpinMessageMutate } = useUnpinMessage()
  const toggleMark = useToggleMark()
  const { mutate: editMessage, mutateAsync: editMessageAsync } = useEditMessage()
  const { mutateAsync: createThreadAsync } = useCreateThread()
  const createForumThreadMut = useCreateForumThread()
  const updatePostTagsMut = useUpdatePostTags()
  const deleteForumThreadMut = useDeleteForumThread()
  const setMemberRoleMut = useSetMemberRole()
  const kickMemberMut = useKickMember()
  const setChannelNotifMut = useSetChannelNotif()
  const { mutateAsync: uploadFileAsync } = useUploadFile()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])

  // ── Local UI state ──────────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)
  const [localName, setLocalName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])
  // Seed the scroll target from the mount-time jump target (if any) so
  // `MessageList` scrolls to + highlights the message once the anchored window
  // loads it. Unlike the reply-pill path (100ms fixed-timer clear), this is
  // cleared by an effect once the row is actually present (below) — the anchor
  // page is still being fetched over the network, so a fixed timer would race
  // and lose the "guaranteed land".
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(jumpTargetId)

  // Strip `?msg=` from the URL right after mount so a refresh/back doesn't
  // re-trigger the jump. The frozen `jumpTargetId` + seeded `scrollToMessageId`
  // still drive this mount's anchor and scroll; this only cleans the address.
  useEffect(() => {
    if (!jumpTargetId) return
    router.replace(`/c/channels/${serverParam}/${channelId}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this mount's jump
  }, [])

  // Clear the jump scroll target once the target row is present in the loaded
  // window (guaranteed-land: don't clear on a fixed timer while the anchor page
  // is still in flight). Fallback: if the load has fully SETTLED (not
  // loading/fetching) and the row still isn't here — e.g. the message was
  // deleted between navigation and load, or the anchor fetch failed — the row
  // will never appear, so release the state rather than leak it for the mount.
  useEffect(() => {
    if (!isChildChannel || !scrollToMessageId) return
    if (messages.some((m) => m.id === scrollToMessageId)) {
      const t = setTimeout(() => setScrollToMessageId((v) => (v === scrollToMessageId ? null : v)), 1600)
      return () => clearTimeout(t)
    }
    const settled =
      !messagesLoading && !isFetchingOlderMessages && !isFetchingNewerMessages
    if (settled) setScrollToMessageId((v) => (v === scrollToMessageId ? null : v))
  }, [isChildChannel, scrollToMessageId, messages, messagesLoading, isFetchingOlderMessages, isFetchingNewerMessages])

  // Channel switch — reset every piece of UI state scoped to the previous
  // channel. `ChannelView` is keyed by `serverId/channelId`, so this remounts on
  // switch; the effect is a belt-and-suspenders reset. NB: `scrollToMessageId`
  // is intentionally NOT reset here — it's seeded from the mount-time jump
  // target and cleared by its own effect once the row lands; clearing it here
  // would clobber a `?msg=` jump on the first render.
  useEffect(() => {
    setReplyTo(null)
    setRightPanel(null)
    setSearchQuery("")
    setSearchResults([])
    setLocalName(null)
    setMemberQuery("")
    setManageMembersOpen(false)
  }, [channelId])

  const doSearch = useCallback(async (q: string) => {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults([]); return }
    try {
      const params = new URLSearchParams({ q })
      if (params) params.set("channelId", channelId)
      const data = await apiFetch<{ results: Array<{ message: { id: string; content: string; authorId: string; createdAt: string }; author: { name: string; image: string | null } }> }>(`/api/community/messages/search?${params}`)
      setSearchResults(data.results.map((r) => ({
        id: r.message.id,
        type: "chat" as const,
        authorName: r.author.name,
        authorAvatar: r.author.image ?? avatarInitial(r.author.name),
        content: r.message.content,
        createdAt: r.message.createdAt,
      })))
    } catch (e) {
      setSearchResults([])
      toastApiError(e, "Search failed")
    }
  }, [channelId])

  // Find the channel name
  const channelName = useMemo(() => {
    const thread = threads.find((t) => t.id === channelId)
    return resolveChannelDisplayName({
      localName,
      forumPostTitle: isForumPostChild ? forumPostOpener?.content : null,
      topLevelName: channelInServer?.name,
      childChannelName: isForumPostChild ? null : currentChannelMeta?.name,
      forumListName: null,
      threadListName: thread?.name,
      fallback: isForumPostChild ? "Post" : "channel",
    })
  }, [localName, isForumPostChild, forumPostOpener, channelInServer, threads, currentChannelMeta, channelId])

  // Pinned message ids
  const pinnedIds = useMemo(() => new Set(pinned.map((p) => p.id)), [pinned])

  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  const enterThread = useCallback((id: string) => {
    // No eager read PUT here — the thread page's `useEagerChannelRead` fires it
    // on mount AFTER its read-state snapshot latches, so the "New" divider
    // still anchors to the pre-open pointer. A PUT here would race the snapshot.
    router.push(`/c/channels/${serverParam}/${id}`)
  }, [router, serverParam])

  // The message context side sheet's target. A message ref opens it to preview
  // a message + surrounding context WITHOUT navigating (Gus #417). The target
  // carries the source channel (which may differ from the open one — a
  // cross-channel ref) so the sheet resolves that channel's seq and shows its
  // name in the header. `label` is the source channel's display name (passed in
  // so the sheet needn't refetch metadata).
  const [contextTarget, setContextTarget] = useState<
    { serverId: string; channelId: string; label: string; seq: number } | null
  >(null)
  // Chained `#N` refs inside the sheet reopen it on the new seq — same channel
  // as the currently-shown one (a `#N` in a previewed message is scoped to that
  // message's channel).
  const openContextSeq = useCallback((seq: number) => {
    setContextTarget((prev) =>
      prev ? { ...prev, seq } : { serverId, channelId, label: channelName, seq },
    )
  }, [serverId, channelId, channelName])

  // Reply clicked inside the context sheet. Same-channel preview → seed THIS
  // channel's composer directly. Cross-channel preview → you can't reply here to
  // a message that lives in another channel (Gus #449/#452), so hand the target
  // off through the store and navigate to that message's channel; its page seeds
  // its own composer on arrival (see the pendingReply effect below). Reply stays
  // available in both cases — it just routes you to where the reply belongs.
  const onSheetReply = useCallback((target: { id: string; authorName: string; text: string }) => {
    if (contextTarget && contextTarget.channelId !== channelId) {
      useCommunityStore.getState().setPendingReply({ channelId: contextTarget.channelId, target })
      setContextTarget(null)
      uiHandlers.navigate?.(contextTarget.serverId, contextTarget.channelId)
    } else {
      setReplyTo(target)
      setContextTarget(null)
    }
  }, [contextTarget, channelId, uiHandlers])

  // Consume a reply handed off from a cross-channel sheet on another page: if a
  // pendingReply targets THIS channel, seed the composer once and clear it.
  const pendingReply = useCommunityStore((s) => s.pendingReply)
  useEffect(() => {
    if (pendingReply && pendingReply.channelId === channelId) {
      setReplyTo(pendingReply.target)
      useCommunityStore.getState().setPendingReply(null)
    }
  }, [pendingReply, channelId])

  // Same-channel message ref (`/server/channel#N`, channel open) via `jumpToSeq`:
  // message loaded in the window → scroll+highlight it in place; not loaded →
  // open the context sheet on THIS channel. Reads `messages` lazily off the
  // actions ref so the callback stays reference-stable (no memo churn).
  const jumpToSeq = useCallback((seq: number) => {
    const msg = actionsCtxRef.current.messages.find((m) => m.seq === seq)
    if (msg) actionsCtxRef.current.setScrollTargetId(msg.id)
    else setContextTarget({ serverId, channelId, label: channelName, seq })
  }, [serverId, channelId, channelName])
  // Cross-channel message ref via `openMessageContext`: open the sheet IN PLACE
  // on the target (other) channel — never navigate (Gus #417). The sheet's
  // access-checked read path returns not-found for a channel the viewer can't
  // see, so a private-channel ref leaks nothing.
  const openMessageContext = useCallback(
    (target: { serverId: string; channelId: string; label: string; seq: number }) => setContextTarget(target),
    [],
  )
  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({ jumpToSeq, openMessageContext })
    return () => useCommunityStore.getState().registerUiHandlers({ jumpToSeq: undefined, openMessageContext: undefined })
  }, [jumpToSeq, openMessageContext])

  // Marked-tab (and any cross-channel) deep-link: a `?seq=<n>` on the URL opens
  // the context sheet on that message. Unlike the `?msg=` mount-anchor path,
  // this is an EFFECT keyed on the seq param — so it fires even when navigating
  // to an ALREADY-MOUNTED channel page (Next reuses the component, so a
  // mount-once useState read would miss the new param). The sheet reads by
  // (channelId, seq) and cold-fetches its own window, so the target row need
  // not be in the loaded list. We strip the param right after so a refresh/back
  // doesn't re-open it, and re-arm cleanly for the next jump.
  const seqParam = searchParams.get("seq")
  useEffect(() => {
    if (!seqParam) return
    const seq = Number(seqParam)
    if (!Number.isFinite(seq)) return
    setContextTarget({ serverId, channelId, label: channelName, seq })
    router.replace(`/c/channels/${serverParam}/${channelId}`, { scroll: false })
  }, [seqParam, serverId, channelId, channelName, router, serverParam])

  // Stable so it doesn't bust the memoized message rows; reads uiHandlers
  // lazily through the actions ref (assigned just below).
  const openProfile = useCallback<OpenProfile>((name, e, discriminator, userId) => {
    actionsCtxRef.current.uiHandlers.openProfile?.(name, e, discriminator, userId)
  }, [])

  // ── Message actions ─────────────────────────────────────────────────────
  //
  // Swallow send failures at the caller boundary. `useSendMessage`'s `onError`
  // already marks the optimistic row `failed: true` AND fires the rate-limit
  // toast; we don't need the raw rejection to propagate any further. Letting
  // it escape via `mutateAsync` would surface a bare `ApiError` in the Next.js
  // error overlay (rate-limit path was the reproducer). Returning `null`
  // instead lets thread-create + retry callers detect failure without a
  // try/catch each.
  const messageScope = useMemo(
    () => ({ kind: "channel" as const, id: channelId, serverId }),
    [channelId, serverId],
  )

  const runAcceptedIntent = useCallback(
    async (nonce: string) => {
      const streamStore = useMessageStreamStore.getState()
      const payload = streamStore.getRetryPayload(messageScope, nonce)
      if (!payload) return
      let uploadedAttachments: UploadedAttachment[] | undefined
      if (payload.localUploads.length > 0 && payload.uploadStatus === "settled") {
        const projected = payload.message.attachments
        if (projected?.length === payload.localUploads.length) {
          uploadedAttachments = projected.map((attachment, index) => {
            const local = payload.localUploads[index]
            return {
              id: attachment.url.slice(attachment.url.lastIndexOf("/") + 1),
              filename: local.file.name,
              contentType: local.file.type,
              size: local.file.size,
              width: local.width,
              height: local.height,
            }
          })
        }
      }
      if (payload.localUploads.length > 0 && !uploadedAttachments) {
        const results = await Promise.all(
          payload.localUploads.map((upload) =>
            uploadFileAsync({
              target: { channelId },
              file: upload.file,
              width: upload.width,
              height: upload.height,
            }).catch((error) => {
              toastApiError(error, "Failed to attach file")
              return null
            }),
          ),
        )
        if (results.some((result) => result === null)) {
          streamStore.dispatch(messageScope, { type: "uploadFailed", nonce })
          return
        }
        uploadedAttachments = zipUploadResultsWithDimensions(results, [...payload.localUploads])
        streamStore.dispatch(messageScope, {
          type: "uploadSettled",
          nonce,
          attachments: uploadedAttachments.map((attachment) =>
            toAttachmentVm(channelId, attachment)),
        })
      }
      try {
        await sendMessageAsync({
          serverId,
          channelId,
          content: payload.message.content ?? "",
          replyToId: payload.message.replyTo?.id,
          mentionType: payload.mentionType,
          attachments: uploadedAttachments,
          nonce,
          author: {
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar,
          },
        })
      } catch {
        return
      }
    },
    [messageScope, uploadFileAsync, channelId, sendMessageAsync, serverId, currentUser.id, currentUser.name, currentUser.avatar],
  )

  // Latest-ref for the values the message actions read at call time. Keeping
  // these off the callback deps lets `messageActions` stay reference-STABLE
  // across renders (a new `messages` array on every WS tick would otherwise
  // rebuild every handler and defeat the memoized message rows). The handlers
  // only ever read these lazily on click, so a ref is exactly right.
  const actionsCtxRef = useRef<{
    messages: Msg[]
    pinnedIds: Set<string>
    channelName: string
    uiHandlers: typeof uiHandlers
    setScrollTargetId: (targetId: string | null) => void
  }>({ messages, pinnedIds, channelName, uiHandlers, setScrollTargetId: setScrollToMessageId })
  // Latest-ref write during render is intentional here: the ref only feeds
  // click-time reads inside the stable `messageActions` callbacks, never
  // render output, so it can't cause a missed update.
  /* eslint-disable-next-line react-hooks/immutability -- latest-ref for lazy click reads */
  actionsCtxRef.current = { messages, pinnedIds, channelName, uiHandlers, setScrollTargetId: setScrollToMessageId }

  const messageActions = useMemo(() => ({
    onToggleReaction: (id: string, emoji: string) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: currentUser.id }),
    onReact: (id: string, emoji: string) =>
      toggleReactionApi({ serverId, channelId, messageId: id, emoji, userId: currentUser.id }),
    onReply: (id: string) => {
      const m = actionsCtxRef.current.messages.find((x) => x.id === id)
      if (m) setReplyTo({ id: m.id, authorName: m.authorName ?? "", text: m.content ?? "" })
    },
    onPin: (id: string) => {
      const isPinned = actionsCtxRef.current.pinnedIds.has(id)
      if (isPinned) {
        unpinMessageMutate({ channelId, messageId: id }, {
          onSuccess: () => toast("Message unpinned"),
          onError: (e) => toastApiError(e, "Failed to unpin message"),
        })
      } else {
        pinMessageMutate({ channelId, messageId: id }, {
          onSuccess: () => toast("Message pinned"),
          onError: (e) => toastApiError(e, "Failed to pin message"),
        })
        setRightPanel("pinned")
      }
    },
    onMark: (id: string) => toggleMark(channelId, id),
    onCreateThread: async (id: string) => {
      const m = actionsCtxRef.current.messages.find((x) => x.id === id)
      const name = deriveThreadName(m?.content, actionsCtxRef.current.channelName)
      try {
        const data = await createThreadAsync({ serverId, channelId, messageId: id, name })
        router.push(`/c/channels/${serverParam}/${data.id}`)
      } catch (e) {
        toastApiError(e, "Failed to create thread")
      }
    },
    onCopy: (id: string) => {
      const m = actionsCtxRef.current.messages.find((x) => x.id === id)
      if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
    },
    onEdit: (id: string) => {
      const m = actionsCtxRef.current.messages.find((x) => x.id === id)
      if (!m?.content || m.authorId !== currentUser.id || m.seq === undefined) return
      const content = window.prompt("Edit message", m.content)
      if (!content || content === m.content) return
      editMessage({ serverId, channelId, messageId: id, content }, {
        onError: (e) => toastApiError(e, "Failed to edit message"),
      })
    },
    onRetry: (id: string) => {
      const m = actionsCtxRef.current.messages.find((x) => x.id === id)
      if (!m?.clientNonce) return
      useMessageStreamStore.getState().dispatch(messageScope, { type: "retry", nonce: m.clientNonce })
      void runAcceptedIntent(m.clientNonce)
    },
    onDismiss: (id: string) => {
      const m = actionsCtxRef.current.messages.find((x) => x.id === id)
      if (!m?.clientNonce) return
      useMessageStreamStore.getState().dispatch(messageScope, {
        type: "dismissFailed",
        nonce: m.clientNonce,
      })
    },
    onPreviewImage: (url: string) => {
      actionsCtxRef.current.uiHandlers.previewImage?.(url)
    },
    onDownloadFile: (url: string) => {
      const a = document.createElement("a")
      a.href = url
      a.download = url.split("/").pop() ?? "file"
      a.click()
    },
    // Deps are all reference-stable: channelId/currentUser.id (strings),
    // toggleReactionApi (useCallback), the mutation METHODS (TanStack binds
    // `.mutate`/`.mutateAsync` stably — NOT the whole mutation object, which is
    // a new wrapper every render), doSend (useCallback), router/params. Volatile
    // reads go through actionsCtxRef. This stability is load-bearing: an unstable
    // messageActions busts MessageRow/Message's memo and re-renders every visible
    // row on every commit (see message.tsx messagePropsEqual).
  }), [serverId, channelId, currentUser.id, toggleReactionApi, unpinMessageMutate, pinMessageMutate, toggleMark, createThreadAsync, editMessage, messageScope, runAcceptedIntent, router, serverParam])

  const threadActions = useMemo(
    () => ({ ...messageActions, onCreateThread: undefined }),
    [messageActions],
  )
  const syncTextController = useCallback((controller: Parameters<NonNullable<React.ComponentProps<typeof TextChannelSurface>["onController"]>>[0]) => {
    // Latest-ref synchronization runs from TextChannelSurface's layout effect,
    // never during this component's render.
    // eslint-disable-next-line react-hooks/immutability
    actionsCtxRef.current = {
      messages: controller.messages,
      pinnedIds: new Set(controller.pinned.map((message) => message.id)),
      channelName,
      uiHandlers,
      setScrollTargetId: controller.setScrollTargetId,
    }
  }, [channelName, uiHandlers])

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

  // ── Send messages ───────────────────────────────────────────────────────
  const acceptMessage = (markdown: string, attachments?: SendAttachment[], mentionType?: MentionType): boolean => {
    if (!markdown && !attachments?.length) return false
    const nonce = sendNonce()
    const createdPreviewUrls: string[] = []
    const accepted = useMessageStreamStore.getState().accept(messageScope, {
      nonce,
      tempId: tempMessageId(),
      message: {
        type: "chat",
        authorId: currentUser.id,
        authorName: currentUser.name,
        authorAvatar: currentUser.avatar,
        content: markdown,
        createdAt: new Date().toISOString(),
        ...(replyTo ? { replyTo: { id: replyTo.id, authorName: replyTo.authorName, text: replyTo.text.slice(0, 100) } } : {}),
      },
      localUploads: attachments?.map((attachment) => {
        const previewObjectUrl = attachment.previewObjectUrl ?? URL.createObjectURL(attachment.file)
        if (!attachment.previewObjectUrl) createdPreviewUrls.push(previewObjectUrl)
        return {
          file: attachment.file,
          previewObjectUrl,
          width: attachment.width,
          height: attachment.height,
        }
      }) ?? [],
      mentionType,
    })
    if (!accepted) {
      for (const url of createdPreviewUrls) URL.revokeObjectURL(url)
      return false
    }
    void runAcceptedIntent(nonce)
    communityWsResetTypingThrottle({ channelId })
    setReplyTo(null)
    return true
  }

  const handleTyping = () => {
    communityWsSendTyping({ channelId })
  }

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
  const panelProps = {
    onOpenThread: enterThread,
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
    pinned,
    pinnedLoading,
    searchResults,
    threads,
    threadsLoading,
    searchQuery,
    myRole,
    onSearch: doSearch,
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
    // Pinned-message click routes through the same message-ref jump flow
    // (scroll-in-place if the message is loaded, else open the context sheet),
    // so clicking a pin always gives feedback — even an old, out-of-window one
    // that the scroll-only path used to silently no-op on.
    onJumpToMessage: (seq: number) => jumpToSeq(seq),
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
      <ChannelShell
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
            messages={messages}
            loading={messagesLoading}
            pinnedIds={pinnedIds}
            newDividerBefore={newDividerBefore}
            typingUsers={typingUsers.map((id) => typingNames[id] ?? resolveUserName(id))}
            onOpenThread={() => { }}
            {...threadActions}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            scrollToMessageId={scrollToMessageId}
            hero={opener}
            onScrollRoot={setScrollRootEl}
            viewerUserId={currentUser.id}
            // Same gate as the top-level channel view: hold the mount-time
            // scroll until the read snapshot resolves and its anchor is loaded,
            // so a child thread opens on the "New" divider too.
            initialScrollReady={!readSnapshotFetching && anchorInCache}
            hasMore={hasMoreMessages}
            isFetchingOlder={isFetchingOlderMessages}
            onLoadOlder={fetchOlderMessages}
            hasMoreNewer={hasMoreNewerMessages}
            isFetchingNewer={isFetchingNewerMessages}
            onLoadNewer={fetchNewerMessages}
            onJumpToPresent={jumpToPresent}
            unreadCount={unreadCount}
            onOpenContextSheet={openContextSeq}
          />
          <div data-onboarding-target="channel-composer" className="shrink-0">
            <Composer
              channel={channelName}
              context="thread"
            members={composerMembers}
            onSearchMembers={membersHook.searchMembers}
            channelRefCandidates={channelRefCandidates}
            sendContract="accepted"
            onAcceptSend={acceptMessage}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
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
            {...panelProps}
            onOpenProfile={openProfile}
          />
        )}
        dialogs={<>{manageMembersDialog}<MessageContextSheet
          open={contextTarget !== null}
          onOpenChange={(v) => { if (!v) setContextTarget(null) }}
          channelId={contextTarget?.channelId ?? channelId}
          channelLabel={contextTarget?.label}
          targetSeq={contextTarget?.seq ?? null}
          pinnedIds={pinnedIds}
          onOpenContextSheet={openContextSeq}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          onReply={onSheetReply}
        /></>}
      />
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
            {...panelProps}
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
      viewerUserId={currentUser.id}
      anchorMessageId={jumpTargetId}
      onController={syncTextController}
    >
      {(textFeed) => {
        const textPinnedIds = new Set(textFeed.pinned.map((message) => message.id))
        return (
    <ChannelShell
      header={<ChannelHeader
        channel={channelName}
        rightPanel={rightPanel}
        onToggle={togglePanel}
        notifLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
        onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l }, {
          onError: (e) => toastApiError(e, "Failed to update notification level"),
        })}
        onBack={bp === "mobile" ? goBack : undefined}
        server={bp === "mobile" && currentServer ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon } : undefined}
      />}
      body={<main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList
          // Remount per channel so mount-time initial-scroll fires afresh
          // and internal refs (didInitialScrollRef, lastTailIdRef) reset.
          key={channelId}
          channel={channelName}
          messages={textFeed.messages}
          loading={textFeed.isLoading}
          pinnedIds={textPinnedIds}
          newDividerBefore={textFeed.newDividerBefore}
          typingUsers={typingUsers.map((id) => typingNames[id] ?? resolveUserName(id))}
          onOpenThread={enterThread}
          {...messageActions}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          scrollToMessageId={textFeed.scrollTargetId}
          onScrollRoot={textFeed.setScrollRootEl}
          viewerUserId={currentUser.id}
          // Delay initial scroll until the read-state snapshot resolves AND
          // the anchor it names is actually present in `messages` — see
          // `anchorInCache`'s doc comment above for the mount-vs-Fix-3 race
          // this closes.
          initialScrollReady={!textFeed.readSnapshotFetching && textFeed.anchorInCache}
          hasMore={textFeed.hasMoreOlder}
          isFetchingOlder={textFeed.isFetchingOlder}
          onLoadOlder={textFeed.fetchOlder}
          hasMoreNewer={textFeed.hasMoreNewer}
          isFetchingNewer={textFeed.isFetchingNewer}
          onLoadNewer={textFeed.fetchNewer}
          onJumpToPresent={textFeed.jumpToPresent}
          unreadCount={textFeed.unreadCount}
          onOpenContextSheet={openContextSeq}
        />
        <div data-onboarding-target="channel-composer" className="shrink-0">
          <Composer
            channel={channelName}
            context="channel"
          members={composerMembers}
          onSearchMembers={membersHook.searchMembers}
          channelRefCandidates={channelRefCandidates}
          sendContract="accepted"
          onAcceptSend={acceptMessage}
          onTyping={handleTyping}
          replyingTo={replyTo?.authorName}
          onCancelReply={() => setReplyTo(null)}
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
          {...panelProps}
          pinned={textFeed.pinned}
          pinnedLoading={textFeed.pinnedLoading}
          threads={textFeed.threads}
          threadsLoading={textFeed.threadsLoading}
          onOpenProfile={openProfile}
        />
      )}
      dialogs={<>{manageMembersDialog}<MessageContextSheet
        open={contextTarget !== null}
        onOpenChange={(v) => { if (!v) setContextTarget(null) }}
        channelId={contextTarget?.channelId ?? channelId}
        channelLabel={contextTarget?.label}
        targetSeq={contextTarget?.seq ?? null}
        pinnedIds={textPinnedIds}
        onOpenContextSheet={openContextSeq}
        onOpenProfile={openProfile}
        resolveUserName={resolveUserName}
        onReply={onSheetReply}
      /></>}
    />
        )
      }}
    </TextChannelSurface>
  )
}
