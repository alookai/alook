"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { DmHeader, DmHeaderSkeleton } from "@/components/community/dm-header"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/message-list"
import { MessageContextSheet } from "@/components/community/message-context-sheet"
import { Composer, ComposerSkeleton, type SendAttachment } from "@/components/community/composer"
import type { OpenProfile } from "@/components/community/_types"
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
import { useDms } from "@/hooks/community/use-dms"
import { useFriends } from "@/hooks/community/use-friends"
import { useDmMessages } from "@/hooks/community/use-messages"
import { useDmReadStateSnapshot } from "@/hooks/community/use-dm-read-state"
import { useDmWatermark } from "@/hooks/community/use-dm-watermark"
import { useEagerDmRead } from "@/hooks/community/use-eager-dm-read"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import {
  useSendDmMessage,
  useToggleReactionApi,
  useUploadFile,
  useToggleMark,
  zipUploadResultsWithDimensions,
  sendNonce,
} from "@/hooks/community/mutations"
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

// Thin re-mount wrapper — same reason as the server-side channel view: the
// dynamic segment reuses the same component instance across DM switches, so
// keying by dmId tears down the previous view before the next paints.
export default function DmPage() {
  const params = useParams<{ dmId: string }>()
  return <DmView key={params.dmId} />
}

function DmView() {
  const params = useParams<{ dmId: string }>()
  const dmId = params.dmId
  const bp = useBreakpoint()
  const currentUser = useCurrentUser()
  const currentChannelId = useCurrentChannelId()
  const uiHandlers = useUiHandlers()

  const { dms, isLoading: dmsLoading } = useDms()
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
  const { directory: channelRefDirectory } = useChannelRefDirectory()
  const channelRefCandidates = useMemo(
    () =>
      channelRefDirectory.flatMap((s) =>
        s.channels.map((ch) => ({ id: ch.id, name: ch.name, serverId: s.id, serverName: s.name })),
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
  useDmWatermark({ dmId, messages, scrollRootEl })

  // Eager mark-read on open — clears this DM from the inbox immediately while
  // the frozen `readSnapshot` above keeps the "New" divider anchored to the
  // pre-open pointer. Gated on the snapshot having settled.
  useEagerDmRead({ dmId, snapshotReady: !readSnapshotFetching })

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
  const sendDmMessage = useSendDmMessage()
  const toggleReaction = useToggleReactionApi()
  const uploadFile = useUploadFile()
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
      if (m?.content) {
        sendDmMessage.mutate(
          {
            dmId,
            content: m.content,
            replyToId: m.replyTo?.id,
            // Reuse the failed row's nonce so the resend dedupes server-side if
            // the original committed (`onMutate` drops the stale row first).
            nonce: m.clientNonce,
            author: {
              id: currentUser.id,
              name: currentUser.name,
              avatar: currentUser.avatar,
            },
          },
          { onSuccess: advanceOnboardingAfterSend },
        )
      }
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
  }), [toggleReaction, toggleMark, dmId, currentUser.id, currentUser.name, currentUser.avatar, messages, sendDmMessage, uiHandlers, advanceOnboardingAfterSend])

  // DM endpoint ignores mentionType. Replies are supported — the backend
  // persists replyToId for DMs too.
  const sendDmMsg = async (markdown: string, attachments?: SendAttachment[]) => {
    if (!markdown && !attachments?.length) return
    if (!dmId) return
    let uploadedAttachments: ReturnType<typeof zipUploadResultsWithDimensions> = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((a) =>
          uploadFile.mutateAsync({ target: { dmId }, file: a.file }).catch((e) => {
            toastApiError(e, "Failed to attach file")
            return null
          }),
        ),
      )
      uploadedAttachments = zipUploadResultsWithDimensions(results, attachments)
    }
    sendDmMessage.mutate(
      {
        dmId,
        content: markdown || "",
        replyToId: replyTo?.id,
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        nonce: sendNonce(),
        author: {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
        },
      },
    )
    advanceOnboardingAfterSend()
    communityWsResetTypingThrottle({ channelId: dmId })
    setReplyTo(null)
  }

  const handleTyping = () => { communityWsSendTyping({ channelId: dmId }) }

  // Wait for query to catch up to the URL and for messages to load. See
  // the server-side channel page for the same rationale — the store's
  // channelId sync runs after this render commits, so gate on the two
  // lining up before showing real content.
  const channelHydrated =
    currentChannelId === dmId &&
    !messagesLoading &&
    !dmsLoading
  if (!channelHydrated) {
    return (
      <>
        <DmHeaderSkeleton onBack={bp === "mobile" ? goBack : undefined} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* `key={dmId}` matches the real-content branch below — same
              reconciliation fix as the channel page (see its equivalent
              comment). `variant="dm"` now drives the skeleton shape
              explicitly instead of the removed `dm={!!hero}` inference. */}
          <MessageList key={dmId} channel="" messages={[]} loading={true} onOpenThread={() => { }} variant="dm" />
          <ComposerSkeleton />
        </main>
      </>
    )
  }

  if (!dm) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <span className="text-sm">Conversation not found</span>
      </div>
    )
  }

  const dmBlocked = blocked.some((b) => (b.userId ?? b.id) === dm.userId)

  return (
    <>
      <DmHeader dm={dm} onBack={bp === "mobile" ? goBack : undefined} />
      <main className="flex min-h-0 flex-1 flex-col">
        <MessageList
          key={dmId}
          variant="dm"
          channel={dm.name}
          messages={messages}
          loading={messagesLoading}
          newDividerBefore={newDividerBefore}
          typingUsers={typingUsers.map((id) => typingNames[id] ?? resolveUserName(id))}
          onOpenThread={() => { }}
          onToggleReaction={dmBlocked ? undefined : messageActions.onToggleReaction}
          onReact={dmBlocked ? undefined : messageActions.onReact}
          onReply={dmBlocked ? undefined : messageActions.onReply}
          onCopy={messageActions.onCopy}
          onMark={dmBlocked ? undefined : messageActions.onMark}
          onRetry={dmBlocked ? undefined : messageActions.onRetry}
          onPreviewImage={messageActions.onPreviewImage}
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
          unreadCount={unreadCount}
          onOpenContextSheet={setContextSheetSeq}
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
              channel={dm.name}
              context="dm"
            // DM context short-circuits `rankMentionItems` to `[]` — no popup,
            // no candidate pool needed. Passing [] keeps the Member[] typing
            // honest without shimming friends into a member shape.
            members={[]}
            channelRefCandidates={channelRefCandidates}
            onSend={sendDmMsg}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
            autoFocus={bp !== "mobile"}
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
        onOpenContextSheet={setContextSheetSeq}
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
