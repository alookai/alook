"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import { useBreakpoint } from "@/hooks/use-mobile"
import { DmHeader, DmHeaderSkeleton } from "@/components/community/dm-header"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton } from "@/components/community/composer"
import type { OpenProfile } from "@/components/community/_types"
import {
  useCommunityStore,
  useCurrentChannelId,
  useUiHandlers,
} from "@/stores/community"
import { useOnlineUserIds } from "@/stores/community/ws"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends } from "@/hooks/community/use-friends"
import { useDmMessages } from "@/hooks/community/use-messages"
import { useDmReadStateSnapshot } from "@/hooks/community/use-dm-read-state"
import { useDmWatermark } from "@/hooks/community/use-dm-watermark"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import {
  useSendDmMessage,
  useToggleReactionApi,
  useUploadFile,
} from "@/hooks/community/mutations"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  communityWsSubscribe,
  communityWsUnsubscribe,
  communityWsSendTyping,
  communityWsResetTypingThrottle,
} from "@/hooks/community/use-community-ws"

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
  // Enrich with presence — the Composer @-picker uses `f.status` to render
  // the avatar presence dot; without this enrichment every avatar shows offline.
  const friends = useMemo(
    () =>
      rawFriends.map((f) => ({
        ...f,
        status: onlineUserIds.has(f.userId ?? f.id)
          ? ("online" as const)
          : ("offline" as const),
      })),
    [rawFriends, onlineUserIds],
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
  const newDividerBefore = useMemo(() => {
    if (!readSnapshot) return undefined
    const lastId = readSnapshot.lastReadMessageId
    // First-visit case: viewer never opened this DM (no read-state row
    // yet). The inbox surfaces the DM as unread, so the whole loaded
    // window is unread from the viewer's perspective — anchor the
    // divider on the first non-self message so the user lands centered
    // on "here's what you missed" instead of the bottom.
    if (!lastId) {
      for (const m of messages) {
        if (m.authorId !== currentUser.id) return m.id
      }
      return undefined
    }
    const idx = messages.findIndex((m) => m.id === lastId)
    if (idx === -1) return undefined
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].authorId !== currentUser.id) return messages[i].id
    }
    return undefined
  }, [messages, readSnapshot, currentUser.id])

  // Scroll root of the message list — needed so `useDmWatermark`'s
  // IntersectionObserver measures against the correct viewport rather
  // than the page viewport. Set once by `MessageList` via `onScrollRoot`.
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  useDmWatermark({ dmId, messages, scrollRootEl })

  // `↓ N` unread count. Same math as channel: server truth is
  // `latestSeq - viewerLastReadSeq`. Clamp to 0 in case the read pointer
  // overshoots (e.g. a race between the read-state snapshot and a fresh
  // `latestSeq` fetch).
  const unreadCount = useMemo(() => {
    const seenSeq = readSnapshot?.lastReadSeq ?? 0
    const diff = latestSeq - seenSeq
    return diff > 0 ? diff : 0
  }, [latestSeq, readSnapshot])


  const typingUsers = useCommunityStore((s) => s.typingUsers)
  const sendDmMessage = useSendDmMessage()
  const toggleReaction = useToggleReactionApi()
  const uploadFile = useUploadFile()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])

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
      status: onlineUserIds.has(raw.userId)
        ? ("online" as const)
        : ("offline" as const),
    }
  }, [dms, dmId, onlineUserIds])

  const openProfile: OpenProfile = (name, e) => {
    uiHandlers.openProfile?.(name, e)
  }

  const resolveUserName = useCallback((userId: string) => {
    const f = friends.find((x) => x.userId === userId)
    return f?.name ?? userId
  }, [friends])

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
    onRetry: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m?.content) {
        sendDmMessage.mutate({
          dmId,
          content: m.content,
          author: {
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar,
          },
        })
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
  }), [toggleReaction, dmId, currentUser.id, currentUser.name, currentUser.avatar, messages, sendDmMessage, uiHandlers])

  // DM endpoint ignores mentionType. Replies are supported — the backend
  // persists replyToId for DMs too.
  const sendDmMsg = async (markdown: string, attachments?: File[]) => {
    if (!markdown && !attachments?.length) return
    if (!dmId) return
    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) =>
          uploadFile.mutateAsync({ target: { dmId }, file: f }).catch(() => null),
        ),
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }
    sendDmMessage.mutate({
      dmId,
      content: markdown || "",
      replyToId: replyTo?.id,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      author: {
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
      },
    })
    communityWsResetTypingThrottle({ dmConversationId: dmId })
    setReplyTo(null)
  }

  const handleTyping = () => { communityWsSendTyping({ dmConversationId: dmId }) }

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
          <MessageList channel="" messages={[]} loading={true} onOpenThread={() => {}} hero={<></>} />
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
          channel={dm.name}
          messages={messages}
          loading={messagesLoading}
          newDividerBefore={newDividerBefore}
          typingUsers={typingUsers.map((id) => {
            // In a DM there are only two participants — if the typing id
            // matches the DM's counterpart, use their DM display name.
            // Fall back to friends list (adds names for friend-typers in
            // group DMs when we add them) and finally to the raw id.
            if (dm && id === dm.userId) return dm.name
            return friends.find((f) => f.userId === id)?.name ?? id
          })}
          onOpenThread={() => {}}
          onToggleReaction={dmBlocked ? undefined : messageActions.onToggleReaction}
          onReact={dmBlocked ? undefined : messageActions.onReact}
          onReply={dmBlocked ? undefined : messageActions.onReply}
          onCopy={messageActions.onCopy}
          onRetry={dmBlocked ? undefined : messageActions.onRetry}
          onPreviewImage={messageActions.onPreviewImage}
          onDownloadFile={messageActions.onDownloadFile}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          onScrollRoot={setScrollRootEl}
          viewerUserId={currentUser.id}
          // Delay initial scroll until the read-state snapshot resolves —
          // otherwise the effect fires with `newDividerBefore` still
          // undefined and snaps to bottom before the anchor is known.
          initialScrollReady={!readSnapshotFetching}
          hasMore={hasMoreMessages}
          isFetchingOlder={isFetchingOlderMessages}
          onLoadOlder={fetchOlderMessages}
          hasMoreNewer={hasMoreNewerMessages}
          isFetchingNewer={isFetchingNewerMessages}
          onLoadNewer={fetchNewerMessages}
          onJumpToPresent={jumpToPresent}
          unreadCount={unreadCount}
          hero={
            <>
              <div className="relative mb-3 w-fit"><Avatar label={dm.avatar} size={64} /></div>
              <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.</p>
            </>
          }
        />
        {dmBlocked ? (
          <div className="flex h-14 shrink-0 items-center justify-center border-t border-border/40 px-4 text-sm text-muted-foreground">
            You have blocked this user. Unblock to send messages.
          </div>
        ) : (
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
          />
        )}
      </main>
    </>
  )
}
