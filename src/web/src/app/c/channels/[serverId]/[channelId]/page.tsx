"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channel-header"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton, type SendAttachment } from "@/components/community/composer"
import { ForumView, ForumViewSkeleton } from "@/components/community/forum-view"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { ThreadOpener } from "@/components/community/thread-opener"
import { AddMembersDialog } from "@/components/community/add-members-dialog"
import type { RightPanel, Msg, OpenProfile, Role } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import type { MentionType } from "@alook/shared"
import { isForum as isForumType, deriveThreadName } from "@alook/shared"
import { resolveRowPresence } from "@/lib/community/presence"
import { makeUserNameResolver, displayName } from "@/lib/community/display-name"
import { avatarInitial } from "@/lib/community/avatar"
import {
  useCommunityStore,
  useCurrentChannelId,
  useCurrentChannelMeta,
  useUiHandlers,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useServer } from "@/hooks/community/use-servers"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useChannelMembers, useAddableMembers, useAddChannelMember, useRemoveChannelMember } from "@/hooks/community/use-channel-members"
import { useThreadParticipants, useAddThreadParticipant, useRemoveThreadParticipant } from "@/hooks/community/use-thread-participants"
import { useMessages } from "@/hooks/community/use-messages"
import { useChannelReadStateSnapshot } from "@/hooks/community/use-channel-read-state"
import { useChannelWatermark } from "@/hooks/community/use-channel-watermark"
import { useEagerChannelRead } from "@/hooks/community/use-eager-channel-read"
import {
  useThreads,
  useForumPosts,
  usePins,
} from "@/hooks/community/use-channel-panels"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useOnlineUserIds, useCommunityWsStore } from "@/stores/community/ws"
import {
  useSendMessage,
  useToggleReactionApi,
  usePinMessage,
  useUnpinMessage,
  useCreateThread,
  useCreateForumPost,
  useSetMemberRole,
  useKickMember,
  useSetChannelNotif,
  useUploadFile,
  zipUploadResultsWithDimensions,
  type SendMessageResult,
  type UploadedAttachment,
} from "@/hooks/community/mutations"
import {
  communityWsSubscribe,
  communityWsUnsubscribe,
  communityWsSendTyping,
  communityWsResetTypingThrottle,
} from "@/hooks/community/use-community-ws"

/**
 * /c/channels/:serverId/:channelId
 *
 * - Forum channel: ForumView
 * - Text channel: MessageList + Composer + right panels
 * - Thread / forum-post opened via URL: child-channel view (breadcrumb + list)
 */
export default function ChannelPage() {
  const params = useParams<{ serverId: string; channelId: string }>()
  const key = `${params.serverId}/${params.channelId}`
  return <ChannelView key={key} />
}

function ChannelView() {
  const params = useParams<{ serverId: string; channelId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(params.serverId)
  const channelId = params.channelId
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
  const currentChannelMeta = useCurrentChannelMeta()

  const { server: currentServer } = useServer(serverId)
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
  // Type-gate the forum-posts fetch: only forum channels have a valid
  // /posts endpoint; text channels return 400. Compute the flag BEFORE the
  // hook call so `useForumPosts` can stay disabled for non-forum channels.
  const channelInServer = useMemo(() => {
    const allChannels = currentServer?.categories?.flatMap((c) => c.channels) ?? []
    return allChannels.find((ch) => ch.id === channelId) ?? null
  }, [currentServer, channelId])
  const isForum = isForumType(channelInServer?.type)
  const isChildChannel = !channelInServer && !!currentServer?.categories
  // A thread is a child channel rooted on a message (`parentMessageId`). Forum
  // posts are child channels too but have no `parentMessageId`. Threads are the
  // notification dimension — their drawer shows PARTICIPANTS, not an audience.
  const isThread = isChildChannel && !!currentChannelMeta?.parentMessageId

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
    // Thread/forum-post: privacy is governed by the anchor channel's category.
    const anchorId = isChildChannel
      ? (currentChannelMeta?.parentChannelId ?? channelId)
      : channelId
    const cat = cats.find((c) => c.channels.some((ch) => ch.id === anchorId))
    return !!cat?.private
  }, [currentServer, isChildChannel, currentChannelMeta, channelId])
  const channelMembersHook = useChannelMembers(channelId, currentChannelPrivate && !isThread)
  // Thread drawer shows the notify PARTICIPANT set, not the channel audience.
  const threadParticipantsHook = useThreadParticipants(channelId, isThread)
  const removeThreadParticipantMut = useRemoveThreadParticipant(channelId)
  const addThreadParticipantMut = useAddThreadParticipant(channelId)
  // Channel/post add-picker source + mutations (add: any member; remove/leave).
  const addableChannelMembers = useAddableMembers(channelId, currentChannelPrivate && !isThread)
  const addChannelMemberMut = useAddChannelMember(channelId)
  const removeChannelMemberMut = useRemoveChannelMember(channelId)
  // Thread add-picker source = the parent channel's roster (minus current
  // participants + self, computed at dialog build). Enabled only for threads.
  const threadParentId = isThread ? (currentChannelMeta?.parentChannelId ?? null) : null
  const parentChannelMembersHook = useChannelMembers(threadParentId ?? "", !!threadParentId)

  // Members shown in the right-panel Members drawer:
  //   - thread → its notify participants (mapped to the roster shape).
  //   - private channel/post → the resolved channel audience (locally filtered).
  //   - public → the server roster.
  // All enriched with live presence for the correct dot.
  const panelMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase()
    const withPresence = (m: {
      userId: string; name: string; discriminator?: string; avatar: string
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

    if (isThread) {
      const threadCreatorId = currentChannelMeta?.creatorId
      return threadParticipantsHook.participants
        .filter((p) => matches(p.name ?? "", p.discriminator))
        .map((p) => withPresence({
          userId: p.userId,
          name: displayName(p),
          discriminator: p.discriminator ?? undefined,
          avatar: p.avatar,
          // Thread rows are all real participants (removable); the thread
          // creator's row is locked.
          isCreator: p.userId === threadCreatorId,
        }))
    }
    if (!currentChannelPrivate) return members
    return channelMembersHook.members
      .filter((m) => matches(m.name, m.discriminator))
      .map((m) => withPresence(m))
  }, [
    isThread,
    threadParticipantsHook.participants,
    currentChannelMeta,
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
    // Private unit: scope to the unit's roster. A thread has NO roster of its
    // own — its `channelMembersHook` is disabled — so its mention candidates are
    // the parent channel's members (the same source the add-participants dialog
    // uses). A private channel/post uses its own roster.
    const scopedRoster = isThread ? parentChannelMembersHook.members : channelMembersHook.members
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
    isThread,
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
  // Frozen-once snapshot of the viewer's read pointer for this channel — the
  // anchor for the "New" divider AND the mount-time initial scroll target.
  // The value NEVER changes during the mount even as the watermark advances.
  const { snapshot: readSnapshot, isFetching: readSnapshotFetching } =
    useChannelReadStateSnapshot(channelId)

  // Anchor the initial page on the read pointer so an unread-heavy channel
  // opens with a centered window instead of the newest 50. Pass `undefined`
  // while the snapshot is still resolving — the hook stays disabled until
  // the value settles (a bare `null` would fall back to newest-mode too
  // early).
  const messagesQuery = useMessages(channelId, {
    lastReadMessageId: readSnapshotFetching
      ? undefined
      : (readSnapshot?.lastReadMessageId ?? null),
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
  } = messagesQuery

  // The message immediately after the viewer's `lastReadMessageId` inside the
  // current window. id-first: the invariant guarantees
  // `getMessage(lastReadMessageId).createdAt === lastReadAt`, so we only need
  // the id to find the anchor. `idx === -1` means the last-read message has
  // scrolled off the top of the fetched window — no divider is shown.
  //
  // Skip past runs of viewer-authored messages. The frozen client snapshot
  // doesn't move mid-mount, but the server DOES advance the sender's own
  // watermark on every send (see `createMessage` in
  // `src/shared/src/db/queries/community/message.ts`) — so without this
  // walk, the divider anchors above the viewer's OWN just-sent message,
  // which is never "unread" from the sender's perspective.
  // `anchorFound` and `newDividerBefore` MUST be computed inside the same
  // memo — they used to be two independently-evaluated expressions (a
  // `.findIndex` here, a separate `.some` in `anchorInCache` below) that
  // read the same `messages`/`readSnapshot` inputs but weren't guaranteed to
  // agree on every commit. A real (Playwright-verified) repro showed `mount`
  // firing on a frame where the anchor's presence check passed but this
  // walk hadn't "caught up" yet, burning the one-shot scroll gate with
  // `newDividerBefore: undefined` and permanently missing the divider.
  // Deriving both from one loop makes that class of disagreement impossible.
  const { newDividerBefore, anchorFound } = useMemo(() => {
    if (!readSnapshot) return { newDividerBefore: undefined, anchorFound: false }
    const lastId = readSnapshot.lastReadMessageId
    // First-visit case (viewer never read this channel): anchor the
    // divider on the first non-self message so users landing from
    // inbox / rail see "here's what you missed" instead of the bottom.
    // Mirrors the DM view for parity. No anchor id to find — trivially "in
    // cache".
    if (!lastId) {
      for (const m of messages) {
        if (m.authorId !== currentUser.id) return { newDividerBefore: m.id, anchorFound: true }
      }
      return { newDividerBefore: undefined, anchorFound: true }
    }
    const idx = messages.findIndex((m) => m.id === lastId)
    if (idx === -1) return { newDividerBefore: undefined, anchorFound: false }
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].authorId !== currentUser.id) return { newDividerBefore: messages[i].id, anchorFound: true }
    }
    return { newDividerBefore: undefined, anchorFound: true }
  }, [messages, readSnapshot, currentUser.id])

  // Gates `<MessageList>`'s mount-time scroll action until the anchor
  // (`readSnapshot.lastReadMessageId`) is actually present in the loaded
  // `messages` — not just until the read-state fetch settles. Without this,
  // a stale IDB-hydrated cache (or a same-session anchor drift, e.g.
  // returning from a thread after the watermark advanced) can win the race
  // against `useMessages`' Fix 3 re-validation: `useScrollAnchor`'s mount
  // effect (a `useLayoutEffect`) runs before Fix 3's plain `useEffect` can
  // reset the query, burns its one-shot gate on the wrong window, and never
  // re-fires once the correct data arrives.
  const anchorInCache = anchorFound

  // Scroll root of the message list — needed so `useChannelWatermark`'s
  // IntersectionObserver measures against the correct viewport instead of
  // the page's default viewport. Set once by `MessageList` via
  // `onScrollRoot`.
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  useChannelWatermark({ channelId, messages, scrollRootEl })

  // Eager mark-read on open — clears this channel/thread from the inbox the
  // moment it's opened, while the frozen `readSnapshot` above keeps the "New"
  // divider anchored to the pre-open pointer. Gated on the snapshot having
  // settled (fetching done; `null` = never-visited is a valid resolved state).
  useEagerChannelRead({
    channelId,
    isChildChannel,
    snapshotReady: !readSnapshotFetching,
  })

  // `↓ N` unread count for the anchor-window path — server truth
  // (`latestSeq - viewerLastReadSeq`). Clamped to 0 in case the read
  // pointer somehow overshot latestSeq (e.g. a bot updated latestSeq
  // between the two fetches).
  const unreadCount = useMemo(() => {
    const seenSeq = readSnapshot?.lastReadSeq ?? 0
    const diff = latestSeq - seenSeq
    return diff > 0 ? diff : 0
  }, [latestSeq, readSnapshot])

  const { threads, isLoading: threadsLoading } = useThreads(channelId)
  const { posts: forumPosts, isLoading: forumPostsLoading } = useForumPosts(channelId, isForum)
  const { pins: pinned, isLoading: pinnedLoading } = usePins(channelId)
  const notifs = useNotificationSettings()
  const channelNotif = notifs.channel
  const typingUsers = useCommunityStore((s) => s.typingUsers)

  // Mutations
  const sendMessageMut = useSendMessage()
  const toggleReactionApi = useToggleReactionApi()
  const pinMessageMut = usePinMessage()
  const unpinMessageMut = useUnpinMessage()
  const createThreadMut = useCreateThread()
  const createForumPostMut = useCreateForumPost()
  const setMemberRoleMut = useSetMemberRole()
  const kickMemberMut = useKickMember()
  const setChannelNotifMut = useSetChannelNotif()
  const uploadFileMut = useUploadFile()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])

  // Set the current channel from URL params
  useEffect(() => {
    useCommunityStore.getState().setCurrentChannelId(channelId)
    return () => { useCommunityStore.getState().setCurrentChannelId(null) }
  }, [channelId])

  // ── Subscribe + fetch child-channel meta ──────────────────────────────────
  useEffect(() => {
    if (!channelId) return
    communityWsSubscribe({ channelId })
    // Child channel — fetch meta so the breadcrumb shows the new parent name
    if (isChildChannel) {
      apiFetch<{ id: string; name: string; parentChannelId: string | null; parentMessageId: string | null; creatorId: string | null }>(`/api/community/threads/${channelId}`)
        .then((data) =>
          useCommunityStore
            .getState()
            .setCurrentChannelMeta({
              name: data.name,
              parentChannelId: data.parentChannelId,
              parentMessageId: data.parentMessageId,
              creatorId: data.creatorId,
            }),
        )
        .catch((e) => {
          useCommunityStore.getState().setCurrentChannelMeta(null)
          // A channel not in the server tree is either a real thread/forum-post
          // (meta fetch succeeds above) or one that was just deleted out from
          // under us (meta 404s here). On the delete case, don't strand the user
          // on a dead URL with a misleading "thread" error — bounce to the server
          // root, which forwards to the first remaining channel.
          if (e instanceof ApiError && e.status === 404) {
            router.replace(`/c/channels/${params.serverId}`)
            return
          }
          toastApiError(e, "Failed to load thread")
        })
    } else {
      useCommunityStore.getState().setCurrentChannelMeta(null)
    }
    return () => {
      communityWsUnsubscribe()
    }
  }, [channelId, isChildChannel, params.serverId, router])

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
    router.replace(`/c/channels/${params.serverId}/${channelId}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this mount's jump
  }, [])

  // Clear the jump scroll target once the target row is present in the loaded
  // window (guaranteed-land: don't clear on a fixed timer while the anchor page
  // is still in flight). Fallback: if the load has fully SETTLED (not
  // loading/fetching) and the row still isn't here — e.g. the message was
  // deleted between navigation and load, or the anchor fetch failed — the row
  // will never appear, so release the state rather than leak it for the mount.
  useEffect(() => {
    if (!scrollToMessageId) return
    if (messages.some((m) => m.id === scrollToMessageId)) {
      const t = setTimeout(() => setScrollToMessageId((v) => (v === scrollToMessageId ? null : v)), 1600)
      return () => clearTimeout(t)
    }
    const settled =
      !messagesLoading && !isFetchingOlderMessages && !isFetchingNewerMessages
    if (settled) setScrollToMessageId((v) => (v === scrollToMessageId ? null : v))
  }, [scrollToMessageId, messages, messagesLoading, isFetchingOlderMessages, isFetchingNewerMessages])

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
      const data = await apiFetch<{ results: Array<{ message: { id: string; content: string; authorId: string; createdAt: string }; author: { name: string; image: string | null } }> }>(`/api/community/search?${params}`)
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
    if (localName) return localName
    if (channelInServer) return channelInServer.name
    if (currentChannelMeta?.name) return currentChannelMeta.name
    const post = forumPosts.find((p) => p.id === channelId)
    if (post) return post.name
    const thread = threads.find((t) => t.id === channelId)
    if (thread) return thread.name
    return "channel"
  }, [localName, channelInServer, forumPosts, threads, currentChannelMeta, channelId])

  // Pinned message ids
  const pinnedIds = useMemo(() => new Set(pinned.map((p) => p.id)), [pinned])

  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  const enterThread = (id: string) => {
    // No eager read PUT here — the thread page's `useEagerChannelRead` fires it
    // on mount AFTER its read-state snapshot latches, so the "New" divider
    // still anchors to the pre-open pointer. A PUT here would race the snapshot.
    router.push(`/c/channels/${params.serverId}/${id}`)
  }

  const openProfile: OpenProfile = (name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }

  // ── Message actions ─────────────────────────────────────────────────────
  //
  // Swallow send failures at the caller boundary. `useSendMessage`'s `onError`
  // already marks the optimistic row `failed: true` AND fires the rate-limit
  // toast; we don't need the raw rejection to propagate any further. Letting
  // it escape via `mutateAsync` would surface a bare `ApiError` in the Next.js
  // error overlay (rate-limit path was the reproducer). Returning `null`
  // instead lets thread-create + retry callers detect failure without a
  // try/catch each.
  const doSend = useCallback(
    async (content: string, opts?: { replyToId?: string; mentionType?: MentionType; attachments?: UploadedAttachment[] }): Promise<SendMessageResult | null> => {
      try {
        return await sendMessageMut.mutateAsync({
          channelId,
          content,
          replyToId: opts?.replyToId,
          mentionType: opts?.mentionType,
          attachments: opts?.attachments,
          author: {
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar,
          },
        })
      } catch {
        return null
      }
    },
    [sendMessageMut, channelId, currentUser.id, currentUser.name, currentUser.avatar],
  )

  const messageActions = {
    onToggleReaction: (id: string, emoji: string) =>
      toggleReactionApi({ channelId, messageId: id, emoji, userId: currentUser.id }),
    onReact: (id: string, emoji: string) =>
      toggleReactionApi({ channelId, messageId: id, emoji, userId: currentUser.id }),
    onReply: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m) setReplyTo({ id: m.id, authorName: m.authorName ?? "", text: m.content ?? "" })
    },
    onPin: (id: string) => {
      const isPinned = pinnedIds.has(id)
      if (isPinned) {
        unpinMessageMut.mutate({ channelId, messageId: id }, {
          onSuccess: () => toast("Message unpinned"),
          onError: (e) => toastApiError(e, "Failed to unpin message"),
        })
      } else {
        pinMessageMut.mutate({ channelId, messageId: id }, {
          onSuccess: () => toast("Message pinned"),
          onError: (e) => toastApiError(e, "Failed to pin message"),
        })
        setRightPanel("pinned")
      }
    },
    onCreateThread: async (id: string) => {
      const m = messages.find((x) => x.id === id)
      const name = deriveThreadName(m?.content, channelName)
      try {
        const data = await createThreadMut.mutateAsync({ channelId, messageId: id, name })
        router.push(`/c/channels/${params.serverId}/${data.id}`)
      } catch (e) {
        toastApiError(e, "Failed to create thread")
      }
    },
    onCopy: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
    },
    onRetry: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m?.content) void doSend(m.content)
    },
    onPreviewImage: (url: string) => {
      uiHandlers.previewImage?.(url)
    },
    onDownloadFile: (url: string) => {
      const a = document.createElement("a")
      a.href = url
      a.download = url.split("/").pop() ?? "file"
      a.click()
    },
  }

  const threadActions = { ...messageActions, onCreateThread: undefined }

  const resolveUserName = useMemo(() => makeUserNameResolver(members), [members])

  // ── Send messages ───────────────────────────────────────────────────────
  const sendMessage = async (markdown: string, attachments?: SendAttachment[], mentionType?: MentionType) => {
    if (!markdown && !attachments?.length) return

    let uploadedAttachments: UploadedAttachment[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((a) =>
          uploadFileMut.mutateAsync({ target: { channelId }, file: a.file }).catch((e) => {
            toastApiError(e, "Failed to attach file")
            return null
          }),
        ),
      )
      uploadedAttachments = zipUploadResultsWithDimensions(results, attachments)
    }

    void doSend(markdown || "", {
      replyToId: replyTo?.id,
      mentionType,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
    communityWsResetTypingThrottle({ channelId })
    setReplyTo(null)
  }

  const handleTyping = () => {
    communityWsSendTyping({ channelId })
  }

  const createForumPost = async (post: { name: string; content: string; tags: string[] }) => {
    try {
      const data = await createForumPostMut.mutateAsync({ channelId, ...post })
      // A post is its own child channel — open it, same as clicking a post row.
      enterThread(data.post.id)
    } catch (e) {
      toastApiError(e, "Failed to create post")
    }
  }

  const myRole = members.find((m) => m.userId === currentUser.id)?.role
  // The unit's creator (thread/channel/post) — drives the manage-context
  // creator rules. For a thread the id lives on `currentChannelMeta`; for a
  // top-level channel/post it's on the channel row in the server tree.
  const unitCreatorId = isChildChannel
    ? currentChannelMeta?.creatorId
    : channelInServer?.creatorId
  const viewerIsUnitCreator = !!unitCreatorId && unitCreatorId === currentUser.id
  // The drawer's manage affordance:
  //   - thread → add participants (any participant); rows right-click to
  //     leave/remove.
  //   - private channel/post → add members (any member); rows right-click to
  //     leave (self) / remove (creator).
  //   - FORUM → NO manage button: its membership is the DERIVED union of its
  //     posts (read-only). Add people to individual posts, not the forum.
  // Public channels: no manage button.
  const showManageButton = isThread || (currentChannelPrivate && !isForum)
  // Whether the drawer is on a scoped (participant/audience) source vs the
  // paginated server roster.
  const scopedDrawer = isThread || currentChannelPrivate
  // Row right-click Leave/Remove context — private channel/post + thread only.
  // Remove is creator-only on every unit; the wired mutation differs by unit.
  const manageContext = scopedDrawer && !isForum
    ? {
        viewerUserId: currentUser.id,
        viewerIsCreator: viewerIsUnitCreator,
        onLeave: (userId: string) =>
          (isThread ? removeThreadParticipantMut : removeChannelMemberMut).mutate(userId, {
            onError: (e) => toastApiError(e, "Failed to leave"),
          }),
        onRemove: (userId: string) =>
          (isThread ? removeThreadParticipantMut : removeChannelMemberMut).mutate(userId, {
            onError: (e) => toastApiError(e, "Failed to remove"),
          }),
      }
    : undefined
  const panelProps = {
    onOpenThread: enterThread,
    members: panelMembers,
    membersLoading: isThread
      ? threadParticipantsHook.isLoading
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
    onKickMember: (memberId: string) => {
      kickMemberMut.mutate({ serverId, memberId }, {
        onSuccess: () => toast("Member kicked"),
        onError: (e) => toastApiError(e, "Failed to kick member"),
      })
    },
    onJumpToMessage: (id: string) => {
      setScrollToMessageId(id)
      setTimeout(() => setScrollToMessageId(null), 100)
    },
  }

  // Add-members dialog (shared), mounted when the drawer's Add button fires.
  //   - thread → candidates = parent-channel members not yet participating;
  //     onAdd = add thread participant.
  //   - private channel/post → candidates = server members not in the unit;
  //     onAdd = add channel member (targets `channelId` directly — a forum post
  //     is its own access unit).
  // The current-member list + leave/remove live in the drawer row right-click
  // menu (`manageContext`), not here.
  const manageMembersDialog = (() => {
    if (!manageMembersOpen) return null
    if (isThread) {
      const participantIds = new Set(threadParticipantsHook.participants.map((p) => p.userId))
      const candidates = parentChannelMembersHook.members
        .filter((m) => !participantIds.has(m.userId) && m.userId !== currentUser.id)
        .map((m) => ({ userId: m.userId, name: m.name ?? null, avatar: m.avatar }))
      return (
        <AddMembersDialog
          title={`Add participants to /${currentChannelMeta?.name ?? channelName}`}
          subtitle="Added people are notified of new replies. Anyone with access can already read the thread."
          candidates={candidates}
          addPending={addThreadParticipantMut.isPending}
          onAdd={async (userId) => { await addThreadParticipantMut.mutateAsync(userId) }}
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
        subtitle="Added members can see and post in this channel."
        candidates={candidates}
        addPending={addChannelMemberMut.isPending}
        onAdd={async (userId) => { await addChannelMemberMut.mutateAsync(userId) }}
        onClose={() => setManageMembersOpen(false)}
      />
    )
  })()

  const isPotentialChild = !channelInServer && !!currentServer?.categories
  const bodyLoading = isForum ? forumPostsLoading : messagesLoading
  const channelHydrated =
    currentChannelId === channelId &&
    !bodyLoading &&
    (!isPotentialChild || currentChannelMeta !== null)
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
    const opener = parentMessageId ? (
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
                  `/c/channels/${params.serverId}/${parentId}?msg=${parentMessageId}`,
                )
            : undefined
        }
      />
    ) : undefined
    return (
      <>
        <ChannelHeader
          channel={parentName}
          forum={isForumType(parentChannel?.type)}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          onBack={bp === "mobile" ? () => router.back() : undefined}
          server={bp === "mobile" && currentServer ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon } : undefined}
          tools={{ threads: false }}
          breadcrumb={{
            label: channelName,
            onNavigateBack: () => { if (parentId) router.push(`/c/channels/${params.serverId}/${parentId}`); else router.back() },
            onRename: canManageServer(myRole) ? async (name) => {
              try {
                await apiFetch(`/api/community/channels/${channelId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name }),
                })
                setLocalName(name)
              } catch (e) { toastApiError(e, "Failed to rename") }
            } : undefined,
          }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList
            key={channelId}
            channel={channelName}
            messages={messages}
            loading={messagesLoading}
            pinnedIds={pinnedIds}
            typingUsers={typingUsers.map((id) => resolveUserName(id))}
            onOpenThread={() => { }}
            {...threadActions}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            scrollToMessageId={scrollToMessageId}
            hero={opener}
            viewerUserId={currentUser.id}
            hasMore={hasMoreMessages}
            isFetchingOlder={isFetchingOlderMessages}
            onLoadOlder={fetchOlderMessages}
            hasMoreNewer={hasMoreNewerMessages}
            isFetchingNewer={isFetchingNewerMessages}
            onLoadNewer={fetchNewerMessages}
            onJumpToPresent={jumpToPresent}
            unreadCount={unreadCount}
          />
          <Composer
            channel={channelName}
            context="thread"
            members={composerMembers}
            onSearchMembers={membersHook.searchMembers}
            channelRefCandidates={channelRefCandidates}
            onSend={sendMessage}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
            autoFocus={bp !== "mobile"}
          />
        </main>

        {rightPanel && (
          <CommunityPanelSheet
            open
            onOpenChange={(v) => { if (!v) setRightPanel(null) }}
            kind={rightPanel}
            {...panelProps}
            onOpenProfile={openProfile}
          />
        )}
        {manageMembersDialog}
      </>
    )
  }

  // ── Forum view ──────────────────────────────────────────────────────────
  if (isForum) {
    const allChannels = currentServer?.categories.flatMap((c) => c.channels) ?? []
    const forumChannel = allChannels.find((ch) => ch.id === channelId)
    const forumTags: string[] = forumChannel?.tags ?? []
    const canManage = canManageServer(myRole)
    return (
      <>
        <ChannelHeader
          channel={channelName}
          forum
          rightPanel={rightPanel}
          onToggle={togglePanel}
          notifLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? "Use Server Default"}
          onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l }, {
            onError: (e) => toastApiError(e, "Failed to update notification level"),
          })}
          onBack={bp === "mobile" ? goBack : undefined}
          server={bp === "mobile" && currentServer ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon } : undefined}
          tools={{ threads: false, pinned: false }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ForumView
            posts={forumPosts}
            tags={forumTags}
            loading={forumPostsLoading}
            onOpenPost={enterThread}
            onCreatePost={createForumPost}
            canManageTags={canManage}
            onTagsChanged={canManage ? (tags) => {
              apiFetch(`/api/community/channels/${channelId}`, {
                method: "PATCH",
                body: JSON.stringify({ forumTags: JSON.stringify(tags) }),
              }).catch((e) => toastApiError(e, "Failed to save tags"))
            } : undefined}
          />
        </main>

        {rightPanel && (
          <CommunityPanelSheet
            open
            onOpenChange={(v) => { if (!v) setRightPanel(null) }}
            kind={rightPanel}
            {...panelProps}
            onOpenProfile={openProfile}
          />
        )}
        {manageMembersDialog}
      </>
    )
  }

  // ── Standard channel view ───────────────────────────────────────────────
  return (
    <>
      <ChannelHeader
        channel={channelName}
        rightPanel={rightPanel}
        onToggle={togglePanel}
        notifLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? "Use Server Default"}
        onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l }, {
          onError: (e) => toastApiError(e, "Failed to update notification level"),
        })}
        onBack={bp === "mobile" ? goBack : undefined}
        server={bp === "mobile" && currentServer ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon } : undefined}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList
          // Remount per channel so mount-time initial-scroll fires afresh
          // and internal refs (didInitialScrollRef, lastTailIdRef) reset.
          key={channelId}
          channel={channelName}
          messages={messages}
          loading={messagesLoading}
          pinnedIds={pinnedIds}
          newDividerBefore={newDividerBefore}
          typingUsers={typingUsers.map((id) => resolveUserName(id))}
          onOpenThread={enterThread}
          {...messageActions}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          scrollToMessageId={scrollToMessageId}
          onScrollRoot={setScrollRootEl}
          viewerUserId={currentUser.id}
          // Delay initial scroll until the read-state snapshot resolves AND
          // the anchor it names is actually present in `messages` — see
          // `anchorInCache`'s doc comment above for the mount-vs-Fix-3 race
          // this closes.
          initialScrollReady={!readSnapshotFetching && anchorInCache}
          hasMore={hasMoreMessages}
          isFetchingOlder={isFetchingOlderMessages}
          onLoadOlder={fetchOlderMessages}
          hasMoreNewer={hasMoreNewerMessages}
          isFetchingNewer={isFetchingNewerMessages}
          onLoadNewer={fetchNewerMessages}
          onJumpToPresent={jumpToPresent}
          unreadCount={unreadCount}
        />
        <Composer
          channel={channelName}
          context="channel"
          members={composerMembers}
          onSearchMembers={membersHook.searchMembers}
          channelRefCandidates={channelRefCandidates}
          onSend={sendMessage}
          onTyping={handleTyping}
          replyingTo={replyTo?.authorName}
          onCancelReply={() => setReplyTo(null)}
          autoFocus={bp !== "mobile"}
        />
      </main>

      {rightPanel && (
        <CommunityPanelSheet
          open
          onOpenChange={(v) => { if (!v) setRightPanel(null) }}
          kind={rightPanel}
          {...panelProps}
          onOpenProfile={openProfile}
        />
      )}
      {manageMembersDialog}
    </>
  )
}
