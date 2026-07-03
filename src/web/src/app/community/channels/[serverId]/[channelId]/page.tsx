"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channel-header"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton } from "@/components/community/composer"
import { ForumView, ForumViewSkeleton } from "@/components/community/forum-view"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { NewThreadDialog } from "@/components/community/new-thread-panel"
import type { RightPanel, Msg, OpenProfile, Role } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import type { MentionType } from "@alook/shared"

/**
 * /community/channels/:serverId/:channelId
 *
 * - Forum channel: ForumView
 * - Text channel: MessageList + Composer + right panels
 * - Thread / forum-post opened via URL: child-channel view (breadcrumb + list)
 */
// Thin wrapper that re-keys the actual view on channelId. The page component
// would otherwise stay mounted across channel switches (Next.js dynamic
// segment reuses the same component instance), leaving local state — replyTo,
// pendingFiles, the TipTap editor doc, the rightPanel toggle — visible for a
// frame until the post-render reset effects fire. A keyed remount is
// synchronous: the previous channel's view tears down before the next paints.
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
  const ctx = useCommunity()

  const goBack = useCallback(() => {
    ctx.goBackMobile()
  }, [ctx])

  // Set the current channel from URL params
  useEffect(() => {
    ctx.setCurrentChannelId(channelId)
    return () => { ctx.setCurrentChannelId(null) }
  }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local UI state ──────────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const [creatingThread, setCreatingThread] = useState(false)
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)
  const [localName, setLocalName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null)

  // Channel switch — reset every piece of UI state scoped to the previous
  // channel. Without this the page component stays mounted across channel
  // changes (Next.js dynamic segment), so a stale replyTo would attach a new
  // send to a message id from the previous channel.
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

  // Determine channel type from server categories
  const channelInServer = useMemo(() => {
    const allChannels = ctx.currentServer?.categories?.flatMap((c) => c.channels) ?? []
    return allChannels.find((ch) => ch.id === channelId) ?? null
  }, [ctx.currentServer, channelId])

  const isForum = channelInServer?.type === "forum"
  // If channelId is not in server categories, it's a child channel (post / thread opened via URL)
  const isChildChannel = !channelInServer && !!ctx.currentServer?.categories

  // Find the channel name
  const channelName = useMemo(() => {
    if (localName) return localName
    if (channelInServer) return channelInServer.name
    // Child channel — use meta from context
    if (ctx.currentChannelMeta?.name) return ctx.currentChannelMeta.name
    const post = ctx.forumPosts.find((p) => p.id === channelId)
    if (post) return post.name
    const thread = ctx.threads.find((t) => t.id === channelId)
    if (thread) return thread.name
    return "channel"
  }, [localName, channelInServer, ctx.forumPosts, ctx.threads, ctx.currentChannelMeta, channelId])

  // Pinned message ids
  const pinnedIds = useMemo(() => new Set(ctx.pinned.map((p) => p.id)), [ctx.pinned])

  // ── Panel toggle ────────────────────────────────────────────────────────
  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  const enterThread = (id: string) => {
    router.push(`/community/channels/${params.serverId}/${id}`)
    apiFetch(`/api/community/threads/${id}/read`, { method: "PUT" }).catch(() => {})
  }

  // ── Profile card ────────────────────────────────────────────────────────
  const openProfile: OpenProfile = (name, e) => {
    ctx.openProfile(name, e)
  }

  // ── Message actions ─────────────────────────────────────────────────────
  const messageActions = {
    onToggleReaction: ctx.toggleReaction,
    onReact: ctx.toggleReaction,
    onReply: (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      if (m) setReplyTo({ id: m.id, authorName: m.authorName ?? "", text: m.content ?? "" })
    },
    onPin: (id: string) => {
      const isPinned = pinnedIds.has(id)
      if (isPinned) ctx.unpinMessage(id)
      else { ctx.pinMessage(id); setRightPanel("pinned") }
    },
    onCreateThread: async (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      const name = (m?.content ?? channelName).split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || channelName
      const threadId = await ctx.createThread(id, name)
      if (threadId) router.push(`/community/channels/${params.serverId}/${threadId}`)
    },
    onCopy: (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
    },
    onRetry: (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      if (m?.content) ctx.sendMessage(m.content)
    },
    onPreviewImage: (url: string) => {
      ctx.previewImage(url)
    },
    onDownloadFile: (url: string) => {
      const a = document.createElement("a")
      a.href = url
      a.download = url.split("/").pop() ?? "file"
      a.click()
    },
  }

  // Thread/child-channel: strip actions that don't apply inside a thread
  const threadActions = { ...messageActions, onCreateThread: undefined }

  const resolveUserName = useCallback((userId: string) => {
    const m = ctx.members.find((x) => x.userId === userId)
    return m?.name ?? userId
  }, [ctx.members])

  // ── Send messages ───────────────────────────────────────────────────────
  const sendMessage = async (markdown: string, attachments?: File[], mentionType?: MentionType) => {
    if (!markdown && !attachments?.length) return

    // Upload files first if any
    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) => ctx.uploadFile({ channelId }, f))
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }

    ctx.sendMessage(markdown || "", {
      replyToId: replyTo?.id,
      mentionType,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
    setReplyTo(null)
  }

  // ── Send typing ─────────────────────────────────────────────────────────
  const handleTyping = () => {
    ctx.sendTyping({ channelId })
  }

  // ── Create thread from dialog ───────────────────────────────────────────
  const createThreadFromDialog = async (name: string, firstMessage?: string) => {
    setCreatingThread(false)
    if (firstMessage) {
      const msgId = await ctx.sendMessage(firstMessage)
      if (msgId) await ctx.createThread(msgId, name)
    } else {
      toast("Create a thread by clicking 'Create Thread' on any message")
    }
  }

  // ── Forum posts ─────────────────────────────────────────────────────────
  const createForumPost = (post: { name: string; content: string; tags: string[] }) => {
    ctx.createForumPost(channelId, post)
  }

  // ── Panel props ─────────────────────────────────────────────────────────
  const myRole = ctx.members.find((m) => m.userId === ctx.currentUser.id)?.role
  const panelProps = {
    onOpenThread: enterThread,
    members: ctx.members,
    membersLoading: ctx.membersLoading,
    membersLoadingMore: ctx.membersLoadingMore,
    membersHasMore: ctx.membersHasMore,
    onLoadMoreMembers: ctx.loadMoreMembers,
    onSearchMembers: ctx.searchMembers,
    pinned: ctx.pinned,
    pinnedLoading: ctx.pinnedLoading,
    searchResults,
    threads: ctx.threads,
    threadsLoading: ctx.threadsLoading,
    searchQuery,
    myRole,
    onSearch: doSearch,
    onSetRole: (name: string, role: Role) => {
      const m = ctx.members.find((x) => x.name === name)
      if (m) ctx.setMemberRole(m.id, role)
    },
    onKickMember: (name: string) => {
      const m = ctx.members.find((x) => x.name === name)
      if (m) ctx.kickMember(m.id)
    },
    onJumpToMessage: (id: string) => {
      setScrollToMessageId(id)
      setTimeout(() => setScrollToMessageId(null), 100)
    },
  }

  // Top-level loading gate. The context tracks the active channel id via its
  // own effect, which fires AFTER the URL-driven render commits. Between those
  // two ticks `ctx.currentChannelId` still points at the previous channel and
  // `ctx.messages` is its history. Render the channel shell skeleton until
  // they line up — this also catches the same-server c1 → c2 case where the
  // server detail is already loaded so no other branch would trip.
  // Child channels (thread / forum post) additionally wait on the meta fetch
  // so the breadcrumb shows the new parent name instead of the previous one.
  const isPotentialChild = !channelInServer && !!ctx.currentServer?.categories
  // Forum body has no message list — its skeleton lifts when forumPosts arrive.
  // Text channels lift when messages arrive. Gating a forum on messagesLoading
  // alone made the header flash to real for one frame between "context syncs
  // channelId" and "forum fetch flips forumPostsLoading true".
  const bodyLoading = isForum ? ctx.forumPostsLoading : ctx.messagesLoading
  const channelHydrated =
    ctx.currentChannelId === channelId &&
    !bodyLoading &&
    (!isPotentialChild || ctx.currentChannelMeta !== null)
  if (!channelHydrated) {
    // Forum has no message list / composer — use a filter-bar + card skeleton
    // so the shell doesn't briefly show a chat-shaped placeholder before the
    // forum view mounts. Falls through to the chat shell when the channel type
    // isn't known yet.
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
    const parentId = ctx.currentChannelMeta?.parentChannelId
    const allChannels = ctx.currentServer?.categories?.flatMap((c) => c.channels) ?? []
    const parentChannel = parentId ? allChannels.find((ch) => ch.id === parentId) : null
    const parentName = parentChannel?.name ?? "channel"
    return (
      <>
        <ChannelHeader
          channel={parentName}
          forum={parentChannel?.type === "forum"}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          onBack={bp === "mobile" ? () => router.back() : undefined}
          server={bp === "mobile" && ctx.currentServer ? { name: ctx.currentServer.name, icon: ctx.currentServer.icon } : undefined}
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
            messages={ctx.messages}
            loading={ctx.messagesLoading}
            pinnedIds={pinnedIds}
            typingUsers={ctx.typingUsers.map((id) => ctx.members.find((m) => m.userId === id)?.name ?? id)}
            onOpenThread={() => {}}
            {...threadActions}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            scrollToMessageId={scrollToMessageId}
          />
          <Composer
            channel={channelName}
            context="thread"
            members={ctx.friends}
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
    const allChannels = ctx.currentServer?.categories.flatMap((c) => c.channels) ?? []
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
          notifLevel={(ctx.channelNotif[channelId] as ChannelNotifLevel) ?? "Use Server Default"}
          onSetNotifLevel={(l) => ctx.setChannelNotif(channelId, l)}
          onBack={bp === "mobile" ? goBack : undefined}
          server={bp === "mobile" && ctx.currentServer ? { name: ctx.currentServer.name, icon: ctx.currentServer.icon } : undefined}
          tools={{ threads: false, pinned: false }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ForumView
            posts={ctx.forumPosts}
            tags={forumTags}
            loading={ctx.forumPostsLoading}
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
        notifLevel={(ctx.channelNotif[channelId] as ChannelNotifLevel) ?? "Use Server Default"}
        onSetNotifLevel={(l) => ctx.setChannelNotif(channelId, l)}
        onBack={bp === "mobile" ? goBack : undefined}
        server={bp === "mobile" && ctx.currentServer ? { name: ctx.currentServer.name, icon: ctx.currentServer.icon } : undefined}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList
          channel={channelName}
          messages={ctx.messages}
          loading={ctx.messagesLoading}
          pinnedIds={pinnedIds}
          typingUsers={ctx.typingUsers.map((id) => ctx.members.find((m) => m.userId === id)?.name ?? id)}
          onOpenThread={enterThread}
          {...messageActions}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          scrollToMessageId={scrollToMessageId}
        />
        <Composer
          channel={channelName}
          context="channel"
          members={ctx.friends}
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
