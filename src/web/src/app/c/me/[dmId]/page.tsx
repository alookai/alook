"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { useBreakpoint } from "@/hooks/use-mobile"
import { DmHeader } from "@/components/community/channels/dm-header"
import { DmLoadingFrame } from "@/components/community/channels/dm-loading-frame"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/messages/message-list"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { Composer, type SendAttachment } from "@/components/community/messages/composer"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import {
  useCommunityStore,
  useCurrentChannelId,
  useUiHandlers,
  useTypingUsersForScope,
  useTypingNamesForScope,
} from "@/stores/community"
import { useOnlineUserIds, useCommunityWsStore } from "@/stores/community/ws"
import { tid } from "@/lib/community/testids"
import { resolveRowPresence } from "@/lib/community/presence"
import { makeUserNameResolver } from "@/lib/community/display-name"
import { dmsQueryFn, type DmsResponse } from "@/hooks/community/use-dms"
import { useFriends } from "@/hooks/community/use-friends"
import { useDmMessages } from "@/hooks/community/use-messages"
import { useDmReadStateSnapshot } from "@/hooks/community/use-dm-read-state"
import { useDmWatermark } from "@/hooks/community/use-dm-watermark"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import { toChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import {
  useToggleReactionApi,
  useToggleMark,
} from "@/hooks/community/mutations"
import { useDmMessageSender } from "@/hooks/community/use-dm-message-sender"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  communityWsSubscribe,
  communityWsUnsubscribe,
  communityWsSendTyping,
  communityWsResetTypingThrottle,
} from "@/hooks/community/use-community-ws"
import {
  advanceCommunityOnboarding,
  readCommunityOnboardingState,
} from "@/lib/community-onboarding"
import { notifLevelDisplay, type NotifLevel } from "@alook/shared"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useSetChannelNotif } from "@/hooks/community/mutations"
import { toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

const EMPTY_DMS: DmsResponse["conversations"] = []

// Thin re-mount wrapper — same reason as the server-side channel view: the
// dynamic segment reuses the same component instance across DM switches, so
// keying by dmId tears down the previous view before the next paints.
export default function DmPage() {
  const params = useParams<{ dmId: string }>()
  return <DmView key={params.dmId} />
}

function resolveDmLoadingOwnership({
  hasDm,
  dmsLoading,
  currentChannelMatches,
  readSnapshotFetching,
  messagesLoading,
}: {
  hasDm: boolean
  dmsLoading: boolean
  currentChannelMatches: boolean
  readSnapshotFetching: boolean
  messagesLoading: boolean
}) {
  return {
    fullFramePending: !hasDm && dmsLoading,
    notFound: !hasDm && !dmsLoading,
    messageBodyLoading: hasDm && (
      !currentChannelMatches ||
      readSnapshotFetching ||
      messagesLoading
    ),
  }
}

function DmView() {
  const params = useParams<{ dmId: string }>()
  const dmId = params.dmId
  const bp = useBreakpoint()
  const currentUser = useCurrentUser()
  const currentChannelId = useCurrentChannelId()
  const uiHandlers = useUiHandlers()
  const notifications = useNotificationSettings()
  const setNotification = useSetChannelNotif()

  // MeLayout owns the canonical cold DMs fetch. This second observer consumes
  // that result without treating it as stale on mount; explicit WS/query
  // invalidation still refetches the active canonical key.
  const dmsQuery = useQuery<DmsResponse>({
    queryKey: communityKeys.dms(),
    queryFn: dmsQueryFn,
    staleTime: Infinity,
  })
  const dms = dmsQuery.data?.conversations ?? EMPTY_DMS
  const dmsLoading = dmsQuery.isLoading
  const { friends: rawFriends, blocked } = useFriends()
  const onlineUserIds = useOnlineUserIds()
  const userStatuses = useCommunityWsStore((s) => s.userStatuses)
  // Enrich with presence — the Composer @-picker uses `f.status` to render
  // the avatar presence dot; without this enrichment every avatar shows offline.
  const friends = useMemo(
    () =>
      rawFriends.map((f) => {
        const liveStatus = userStatuses.get(f.userId ?? f.id)
        return {
          ...f,
          status: resolveRowPresence(f, onlineUserIds),
          statusEmoji: liveStatus ? liveStatus.emoji : f.statusEmoji,
          statusText: liveStatus ? liveStatus.text : f.statusText,
        }
      }),
    [rawFriends, onlineUserIds, userStatuses],
  )
  // Frozen-once snapshot of the viewer's DM read pointer — the anchor for
  // the "New" divider AND the initial-page mode. Mirrors the channel-view
  // wiring so both surfaces open with the same anchor-window UX.
  const { snapshot: readSnapshot, isFetching: readSnapshotFetching } =
    useDmReadStateSnapshot(dmId)

  // Anchor the initial page on the viewer's read pointer. Pass `undefined`
  // (not `null`) while the snapshot resolves — the hook's initialPageParam
  // gate treats `undefined` as "not-yet-decided" and stays disabled, so we
  // don't fire a newest-mode fetch that would immediately be superseded.
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
    presentVersion,
    latestSeq,
  } = useDmMessages(dmId, {
    lastReadMessageId: readSnapshotFetching
      ? undefined
      : (readSnapshot?.lastReadMessageId ?? null),
  })

  // Cross-navigation deep-link: a Marked-tab row for a DM message navigates
  // here with `?seq=<n>` and we open the context sheet on that message. Read
  // once at mount (frozen), mirroring the channel page's `?msg=` — a
  // refresh/back doesn't re-trigger it. The DM view has no in-place scroll
  // anchor, so the context sheet (seq → id + surrounding window) is the jump.
  const searchParams = useSearchParams()
  const [initialSeq] = useState<number | null>(() => {
    const raw = searchParams.get("seq")
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : null
  })
  const [contextSheetSeq, setContextSheetSeq] = useState<number | null>(initialSeq)
  // DM composer has no "current server" — flatten every member server's
  // channels into one cross-server candidate list so a `/`-ref can be
  // dropped into a DM (see plan community-channel-ref.md §6).
  const [channelRefDirectoryEnabled, setChannelRefDirectoryEnabled] = useState(false)
  const { directory: channelRefDirectory } = useChannelRefDirectory(channelRefDirectoryEnabled)
  const channelRefCandidates = useMemo(
    () =>
      channelRefDirectory.flatMap((s) =>
        s.channels.map((ch) => toChannelRefCandidate(s, ch)),
      ),
    [channelRefDirectory],
  )
  // Anchor of the "New" divider: the first non-self message after
  // `lastReadMessageId` inside the currently-loaded window. Mirrors the
  // channel-view logic exactly — see channel page for why we skip past
  // runs of viewer-authored messages (the server advances the sender's
  // own watermark on POST, so anchoring above the viewer's own row would
  // never be "unread" from the sender's perspective).
  // `anchorFound` and `newDividerBefore` MUST be computed inside the same
  // memo — mirrors the channel page's identical fix exactly (see its doc
  // comment for the Playwright-verified repro of the mount-vs-Fix-3 race
  // this closes: two independently-evaluated expressions reading the same
  // inputs aren't guaranteed to agree on every commit).
  const { newDividerBefore, anchorFound } = useMemo(() => {
    if (!readSnapshot) return { newDividerBefore: undefined, anchorFound: false }
    const lastId = readSnapshot.lastReadMessageId
    // First-visit case: viewer never opened this DM (no read-state row
    // yet). The inbox surfaces the DM as unread, so the whole loaded
    // window is unread from the viewer's perspective — anchor the
    // divider on the first non-self message so the user lands centered
    // on "here's what you missed" instead of the bottom. No anchor id to
    // find — trivially "in cache".
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

  // Gates `<MessageList>`'s mount-time scroll action until the anchor is
  // actually present in the loaded `messages`.
  const anchorInCache = anchorFound

  // Scroll root of the message list — needed so `useDmWatermark`'s
  // IntersectionObserver measures against the correct viewport rather
  // than the page viewport. Set once by `MessageList` via `onScrollRoot`.
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  useDmWatermark({
    dmId,
    messages,
    scrollRootEl,
    snapshotReady: !readSnapshotFetching,
    confirmedSeq: readSnapshot?.lastReadSeq ?? 0,
  })

  // `↓ N` unread count. Same math as channel: server truth is
  // `latestSeq - viewerLastReadSeq`. Clamp to 0 in case the read pointer
  // overshoots (e.g. a race between the read-state snapshot and a fresh
  // `latestSeq` fetch).
  const unreadCount = useMemo(() => {
    const seenSeq = readSnapshot?.lastReadSeq ?? 0
    const diff = latestSeq - seenSeq
    return diff > 0 ? diff : 0
  }, [latestSeq, readSnapshot])


  const typingUsers = useTypingUsersForScope(`dm:${dmId}`)
  const typingNames = useTypingNamesForScope(`dm:${dmId}`)
  const { accept: acceptDmMessage, retry: retryDmMessage } = useDmMessageSender()
  const toggleReaction = useToggleReactionApi()
  const toggleMark = useToggleMark()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])

  // Jump to a message by seq within THIS DM — invoked by a same-DM message-ref
  // pill via the `jumpToSeq` UI-handler. The DM view has no in-place scroll
  // target prop (unlike the channel page), so always open the context sheet,
  // which resolves seq→id and shows the message with surrounding context.
  const jumpToSeq = useCallback((seq: number) => setContextSheetSeq(seq), [])
  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({ jumpToSeq })
    return () => useCommunityStore.getState().registerUiHandlers({ jumpToSeq: undefined })
  }, [jumpToSeq])

  useEffect(() => {
    useCommunityStore.getState().setCurrentChannelId(dmId)
    communityWsSubscribe({ dmConversationId: dmId })
    return () => {
      useCommunityStore.getState().setCurrentChannelId(null)
      communityWsUnsubscribe()
    }
  }, [dmId])

  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)

  useEffect(() => {
    setReplyTo(null)
  }, [dmId])

  const dm = useMemo(() => {
    const raw = dms.find((d) => d.id === dmId) ?? null
    if (!raw) return null
    return {
      ...raw,
      status: resolveRowPresence(raw, onlineUserIds),
    }
  }, [dms, dmId, onlineUserIds])

  const openProfile: OpenProfile = (name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }

  // A DM contains only two participants, and the friends-based resolver
  // covers neither reliably: the viewer is never in their own friends list,
  // and the counterpart is only there if they're actually a friend. Resolve
  // those two ids explicitly (self → current user, counterpart → the DM's
  // display name) before delegating to friends, so reactions (whose reactor
  // is most often the viewer) never fall through to "Unknown member". Shared
  // by both `typingUsers` and the `resolveUserName` prop so the two paths
  // can't drift.
  const resolveUserName = useMemo(() => {
    const fromFriends = makeUserNameResolver(friends)
    return (userId: string) => {
      if (userId === currentUser.id) return currentUser.name
      if (dm && userId === dm.userId) return dm.name
      return fromFriends(userId)
    }
  }, [friends, currentUser.id, currentUser.name, dm])

  const advanceOnboardingAfterSend = useCallback(() => {
    const state = readCommunityOnboardingState()
    if (state?.status === "active" && state.stage === "dm" && state.dmId === dmId) {
      advanceCommunityOnboarding("dm", "server")
    }
  }, [dmId])

  const messageActions = useMemo(() => ({
    onToggleReaction: (id: string, emoji: string) =>
      toggleReaction({ dmId, messageId: id, emoji, userId: currentUser.id }),
    onReact: (id: string, emoji: string) =>
      toggleReaction({ dmId, messageId: id, emoji, userId: currentUser.id }),
    onReply: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m) setReplyTo({ id: m.id, authorName: m.authorName ?? "", text: m.content ?? "" })
    },
    onCopy: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
    },
    // A DM is a channel (type='dm'), so its id IS the mark route's channelId.
    onMark: (id: string) => toggleMark(dmId, id),
    onRetry: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (!m?.clientNonce) return
      void retryDmMessage(dmId, m.clientNonce).then((result) => {
        if (result.ok) advanceOnboardingAfterSend()
      })
    },
    onDismiss: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (!m?.clientNonce) return
      useMessageStreamStore.getState().dispatch(
        { kind: "dm", id: dmId },
        { type: "dismissFailed", nonce: m.clientNonce },
      )
    },
    onPreviewImage: (image: ImagePreview) => {
      uiHandlers.previewImage?.(image)
    },
    onPreviewAttachment: (attachment: FileAttachment) => {
      uiHandlers.previewAttachment?.(attachment)
    },
    onDownloadFile: (url: string, name: string) => {
      const a = document.createElement("a")
      a.href = url
      a.download = name
      a.click()
    },
  }), [toggleReaction, toggleMark, dmId, currentUser.id, messages, retryDmMessage, uiHandlers, advanceOnboardingAfterSend])

  // DM endpoint ignores mentionType. Replies are supported — the backend
  // persists replyToId for DMs too.
  const acceptDmSend = (markdown: string, attachments?: SendAttachment[]): boolean => {
    const receipt = acceptDmMessage({
      dmId,
      content: markdown,
      replyTo: replyTo ?? undefined,
      attachments,
      author: {
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
      },
    })
    if (!receipt.accepted) return false
    void receipt.committed.then((result) => {
      if (result.ok) advanceOnboardingAfterSend()
    })
    communityWsResetTypingThrottle({ channelId: dmId })
    setReplyTo(null)
    return true
  }

  const handleTyping = () => { communityWsSendTyping({ channelId: dmId }) }

  // The DM row owns header/composer identity. Until it is known, keep the
  // complete DM frame pending; once known, read-state and message fetching
  // are allowed to affect only MessageList below.
  const loadingOwnership = resolveDmLoadingOwnership({
    hasDm: !!dm,
    dmsLoading,
    currentChannelMatches: currentChannelId === dmId,
    readSnapshotFetching,
    messagesLoading,
  })

  if (loadingOwnership.fullFramePending) {
    return <DmLoadingFrame reserveBackSlot={bp === "mobile"} />
  }

  if (loadingOwnership.notFound || !dm) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <span className="text-sm">Conversation not found</span>
      </div>
    )
  }

  const dmBlocked = blocked.some((b) => (b.userId ?? b.id) === dm.userId)

  return (
    <>
      <DmHeader
        dm={dm}
        onBack={bp === "mobile" ? goBack : undefined}
        notifLevel={(notifications.channel[dmId] ?? notifLevelDisplay("all")) as NotifLevel}
        onSetNotifLevel={(level) => setNotification.mutate({ channelId: dmId, level }, {
          onError: (error) => toastApiError(error, "Failed to update notification level"),
        })}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <MessageList
          key={dmId}
          variant="dm"
          channel={dm.name}
          messages={messages}
          loading={loadingOwnership.messageBodyLoading}
          newDividerBefore={newDividerBefore}
          typingUsers={typingUsers.map((id) => typingNames[id] ?? resolveUserName(id))}
          onOpenThread={() => { }}
          onToggleReaction={dmBlocked ? undefined : messageActions.onToggleReaction}
          onReact={dmBlocked ? undefined : messageActions.onReact}
          onReply={dmBlocked ? undefined : messageActions.onReply}
          onCopy={messageActions.onCopy}
          onMark={dmBlocked ? undefined : messageActions.onMark}
          onRetry={dmBlocked ? undefined : messageActions.onRetry}
          onDismiss={dmBlocked ? undefined : messageActions.onDismiss}
          onPreviewImage={messageActions.onPreviewImage}
          onPreviewAttachment={messageActions.onPreviewAttachment}
          onDownloadFile={messageActions.onDownloadFile}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          onScrollRoot={setScrollRootEl}
          viewerUserId={currentUser.id}
          // Delay initial scroll until the read-state snapshot resolves AND
          // the anchor it names is actually present in `messages` — see
          // `anchorInCache`'s doc comment above.
          initialScrollReady={!readSnapshotFetching && anchorInCache}
          hasMore={hasMoreMessages}
          isFetchingOlder={isFetchingOlderMessages}
          onLoadOlder={fetchOlderMessages}
          hasMoreNewer={hasMoreNewerMessages}
          isFetchingNewer={isFetchingNewerMessages}
          onLoadNewer={fetchNewerMessages}
          onJumpToPresent={jumpToPresent}
          presentVersion={presentVersion}
          unreadCount={unreadCount}
          hero={
            <>
              <div className="relative mb-3 w-fit"><Avatar label={dm.avatar} seed={dm.userId} size={64} /></div>
              <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.</p>
            </>
          }
        />
        {dmBlocked ? (
          <div data-testid={tid.dmBlockedNotice} className="flex h-14 shrink-0 items-center justify-center border-t border-border/40 px-4 text-sm text-muted-foreground">
            You have blocked this user. Unblock to send messages.
          </div>
        ) : (
          <div data-onboarding-target="dm-composer" data-onboarding-name={dm.name} className="shrink-0">
            <Composer
              sendContract="accepted"
              channel={dm.name}
              context="dm"
            // DM context short-circuits `rankMentionItems` to `[]` — no popup,
            // no candidate pool needed. Passing [] keeps the Member[] typing
            // honest without shimming friends into a member shape.
            members={[]}
            channelRefCandidates={channelRefCandidates}
            onChannelRefIntent={() => setChannelRefDirectoryEnabled(true)}
            onAcceptSend={acceptDmSend}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
            autoFocus={bp === "desktop"}
              draftKey={`dm/${dmId}`}
            />
          </div>
        )}
      </main>
      <MessageContextSheet
        open={contextSheetSeq !== null}
        onOpenChange={(v) => { if (!v) setContextSheetSeq(null) }}
        channelId={dmId}
        targetSeq={contextSheetSeq}
        type="dm"
        onOpenProfile={openProfile}
        resolveUserName={resolveUserName}
        onReply={dmBlocked ? undefined : (target) => {
          setReplyTo(target)
          setContextSheetSeq(null)
        }}
      />
    </>
  )
}
