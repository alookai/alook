"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channel-header"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton } from "@/components/community/composer"
import { ForumView, ForumViewSkeleton } from "@/components/community/forum-view"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { NewThreadDialog } from "@/components/community/new-thread-panel"
import { ThreadOpener } from "@/components/community/thread-opener"
import type { RightPanel, Msg, OpenProfile, Role } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import type { MentionType } from "@alook/shared"
import {
  useCommunityStore,
  useCurrentChannelId,
  useCurrentChannelMeta,
  useUiHandlers,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useServer } from "@/hooks/community/use-servers"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useMessages } from "@/hooks/community/use-messages"
import { useChannelReadStateSnapshot } from "@/hooks/community/use-channel-read-state"
import { useChannelWatermark } from "@/hooks/community/use-channel-watermark"
import {
  useThreads,
  useForumPosts,
  usePins,
} from "@/hooks/community/use-channel-panels"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useOnlineUserIds } from "@/stores/community/ws"
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
} from "@/hooks/community/mutations"
import {
  communityWsSubscribe,
  communityWsUnsubscribe,
  communityWsSendTyping,
} from "@/hooks/community/use-community-ws"

/**
 * /community/channels/:serverId/:channelId
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
  const serverId = decodeURIComponent(params.serverId)
  const channelId = params.channelId
  const bp = useBreakpoint()
  const currentUser = useCurrentUser()
  const uiHandlers = useUiHandlers()
  const currentChannelId = useCurrentChannelId()
  const currentChannelMeta = useCurrentChannelMeta()

  const { server: currentServer } = useServer(serverId)
  const membersHook = useServerMembers(serverId)
  const onlineUserIds = useOnlineUserIds()
  // Members enriched with presence — used by the message list's typingUsers
  // resolution and the panel roster to render the correct dot.
  const members = useMemo(
    () =>
      membersHook.members.map((m) => ({
        ...m,
        status: m.userId === currentUser.id || onlineUserIds.has(m.userId)
          ? ("online" as const)
          : ("offline" as const),
      })),
    [membersHook.members, onlineUserIds, currentUser.id],
  )
  // Roster passed to the @-mention popover — filters the viewer out.
  // `members` (above) still includes the viewer for the roster / typing lookup;
  // only the composer needs to drop self, since you can't @-mention yourself.
  const composerMembers = useMemo(
    () => members.filter((m) => m.userId !== currentUser.id),
    [members, currentUser.id],
  )
  // Type-gate the forum-posts fetch: only forum channels have a valid
  // /posts endpoint; text channels return 400. Compute the flag BEFORE the
  // hook call so `useForumPosts` can stay disabled for non-forum channels.
  const channelInServer = useMemo(() => {
    const allChannels = currentServer?.categories?.flatMap((c) => c.channels) ?? []
    return allChannels.find((ch) => ch.id === channelId) ?? null
  }, [currentServer, channelId])
  const isForum = channelInServer?.type === "forum"
  const isChildChannel = !channelInServer && !!currentServer?.categories

  const messagesQuery = useMessages(channelId)
  const { messages, isLoading: messagesLoading } = messagesQuery

  // Frozen-once snapshot of the viewer's read pointer for this channel — the
  // anchor for the "New" divider AND the mount-time initial scroll target.
  // The value NEVER changes during the mount even as the watermark advances.
  const { snapshot: readSnapshot } = useChannelReadStateSnapshot(channelId)

  // The message immediately after the viewer's `lastReadMessageId` inside the
  // current window. id-first: the invariant guarantees
  // `getMessage(lastReadMessageId).createdAt === lastReadAt`, so we only need
  // the id to find the anchor. `idx === -1` means the last-read message has
  // scrolled off the top of the fetched window — no divider is shown.
  const newDividerBefore = useMemo(() => {
    const lastId = readSnapshot?.lastReadMessageId
    if (!lastId) return undefined
    const idx = messages.findIndex((m) => m.id === lastId)
    if (idx === -1) return undefined
    return messages[idx + 1]?.id
  }, [messages, readSnapshot])

  // Scroll root of the message list — needed so `useChannelWatermark`'s
  // IntersectionObserver measures against the correct viewport instead of
  // the page's default viewport. Set once by `MessageList` via
  // `onScrollRoot`.
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  useChannelWatermark({ channelId, messages, scrollRootEl })

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
      apiFetch<{ id: string; name: string; parentChannelId: string | null; parentMessageId: string | null }>(`/api/community/threads/${channelId}`)
        .then((data) =>
          useCommunityStore
            .getState()
            .setCurrentChannelMeta({
              name: data.name,
              parentChannelId: data.parentChannelId,
              parentMessageId: data.parentMessageId,
            }),
        )
        .catch(() => useCommunityStore.getState().setCurrentChannelMeta(null))
    } else {
      useCommunityStore.getState().setCurrentChannelMeta(null)
    }
    return () => {
      communityWsUnsubscribe()
    }
  }, [channelId, isChildChannel])

  // ── Local UI state ──────────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const [creatingThread, setCreatingThread] = useState(false)
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)
  const [localName, setLocalName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null)

  // Channel switch — reset every piece of UI state scoped to the previous channel.
  useEffect(() => {
    setReplyTo(null)
    setRightPanel(null)
    setSearchQuery("")
    setSearchResults([])
    setLocalName(null)
    setScrollToMessageId(null)
    setCreatingThread(false)
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
        authorName: r.author.name,
        authorAvatar: r.author.image ?? r.author.name.charAt(0).toUpperCase(),
        content: r.message.content,
        createdAt: r.message.createdAt,
      })))
    } catch { setSearchResults([]) }
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
    router.push(`/community/channels/${params.serverId}/${id}`)
    apiFetch(`/api/community/threads/${id}/read`, { method: "PUT" }).catch(() => {})
  }

  const openProfile: OpenProfile = (name, e) => {
    uiHandlers.openProfile?.(name, e)
  }

  // ── Message actions ─────────────────────────────────────────────────────
  const doSend = useCallback(
    (content: string, opts?: { replyToId?: string; mentionType?: MentionType; attachments?: { url: string; filename: string; contentType: string; size: number }[] }) => {
      return sendMessageMut.mutateAsync({
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
          onError: () => toast("Failed to unpin message"),
        })
      } else {
        pinMessageMut.mutate({ channelId, messageId: id }, {
          onSuccess: () => toast("Message pinned"),
          onError: () => toast("Failed to pin message"),
        })
        setRightPanel("pinned")
      }
    },
    onCreateThread: async (id: string) => {
      const m = messages.find((x) => x.id === id)
      const name = (m?.content ?? channelName).split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || channelName
      try {
        const data = await createThreadMut.mutateAsync({ channelId, messageId: id, name })
        router.push(`/community/channels/${params.serverId}/${data.id}`)
      } catch {
        toast("Failed to create thread")
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

  const resolveUserName = useCallback((userId: string) => {
    const m = members.find((x) => x.userId === userId)
    return m?.name ?? userId
  }, [members])

  // ── Send messages ───────────────────────────────────────────────────────
  const sendMessage = async (markdown: string, attachments?: File[], mentionType?: MentionType) => {
    if (!markdown && !attachments?.length) return

    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) =>
          uploadFileMut.mutateAsync({ target: { channelId }, file: f }).catch(() => null),
        ),
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }

    void doSend(markdown || "", {
      replyToId: replyTo?.id,
      mentionType,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
    setReplyTo(null)
  }

  const handleTyping = () => {
    communityWsSendTyping({ channelId })
  }

  const createThreadFromDialog = async (name: string, firstMessage?: string) => {
    setCreatingThread(false)
    if (firstMessage) {
      try {
        const result = await doSend(firstMessage)
        if (result?.message?.id) {
          await createThreadMut.mutateAsync({ channelId, messageId: result.message.id, name })
        }
      } catch {
        toast("Failed to create thread")
      }
    } else {
      toast("Create a thread by clicking 'Create Thread' on any message")
    }
  }

  const createForumPost = (post: { name: string; content: string; tags: string[] }) => {
    createForumPostMut.mutate({ channelId, ...post }, {
      onError: () => toast("Failed to create post"),
    })
  }

  const myRole = members.find((m) => m.userId === currentUser.id)?.role
  const panelProps = {
    onOpenThread: enterThread,
    members,
    membersLoading: membersHook.loading,
    membersLoadingMore: membersHook.loadingMore,
    membersHasMore: membersHook.hasMore,
    onLoadMoreMembers: membersHook.loadMore,
    onSearchMembers: membersHook.searchMembers,
    pinned,
    pinnedLoading,
    searchResults,
    threads,
    threadsLoading,
    searchQuery,
    myRole,
    onSearch: doSearch,
    onSetRole: (name: string, role: Role) => {
      const m = members.find((x) => x.name === name)
      if (m) {
        setMemberRoleMut.mutate({ serverId, memberId: m.id, role }, {
          onSuccess: () => toast("Role updated"),
          onError: () => toast("Failed to update role"),
        })
      }
    },
    onKickMember: (name: string) => {
      const m = members.find((x) => x.name === name)
      if (m) {
        kickMemberMut.mutate({ serverId, memberId: m.id }, {
          onSuccess: () => toast("Member kicked"),
          onError: () => toast("Failed to kick member"),
        })
      }
    },
    onJumpToMessage: (id: string) => {
      setScrollToMessageId(id)
      setTimeout(() => setScrollToMessageId(null), 100)
    },
  }

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
          <MessageList channel="" messages={[]} loading={true} onOpenThread={() => {}} />
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
      />
    ) : undefined
    return (
      <>
        <ChannelHeader
          channel={parentName}
          forum={parentChannel?.type === "forum"}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          onBack={bp === "mobile" ? () => router.back() : undefined}
          server={bp === "mobile" && currentServer ? { name: currentServer.name, icon: currentServer.icon } : undefined}
          tools={{ threads: false }}
          breadcrumb={{
            label: channelName,
            onNavigateBack: () => { if (parentId) router.push(`/community/channels/${params.serverId}/${parentId}`); else router.back() },
            onRename: canManageServer(myRole) ? async (name) => {
              try {
                await apiFetch(`/api/community/channels/${channelId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name }),
                })
                setLocalName(name)
              } catch { toast("Failed to rename") }
            } : undefined,
          }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList
            channel={channelName}
            messages={messages}
            loading={messagesLoading}
            pinnedIds={pinnedIds}
            typingUsers={typingUsers.map((id) => members.find((m) => m.userId === id)?.name ?? id)}
            onOpenThread={() => {}}
            {...threadActions}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            scrollToMessageId={scrollToMessageId}
            hero={opener}
          />
          <Composer
            channel={channelName}
            context="thread"
            members={composerMembers}
            onSearchMembers={membersHook.searchMembers}
            onSend={sendMessage}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
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
          onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l })}
          onBack={bp === "mobile" ? goBack : undefined}
          server={bp === "mobile" && currentServer ? { name: currentServer.name, icon: currentServer.icon } : undefined}
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
              }).catch(() => toast("Failed to save tags"))
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
        onSetNotifLevel={(l) => setChannelNotifMut.mutate({ channelId, level: l })}
        onBack={bp === "mobile" ? goBack : undefined}
        server={bp === "mobile" && currentServer ? { name: currentServer.name, icon: currentServer.icon } : undefined}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList
          channel={channelName}
          messages={messages}
          loading={messagesLoading}
          pinnedIds={pinnedIds}
          newDividerBefore={newDividerBefore}
          typingUsers={typingUsers.map((id) => members.find((m) => m.userId === id)?.name ?? id)}
          onOpenThread={enterThread}
          {...messageActions}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          scrollToMessageId={scrollToMessageId}
          onScrollRoot={setScrollRootEl}
        />
        <Composer
          channel={channelName}
          context="channel"
          members={composerMembers}
          onSearchMembers={membersHook.searchMembers}
          onSend={sendMessage}
          onCreateThread={() => setCreatingThread(true)}
          onTyping={handleTyping}
          replyingTo={replyTo?.authorName}
          onCancelReply={() => setReplyTo(null)}
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

      <NewThreadDialog
        channel={channelName}
        open={creatingThread}
        onClose={() => setCreatingThread(false)}
        onCreate={createThreadFromDialog}
      />
    </>
  )
}
