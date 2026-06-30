"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channel-header"
import { DmHeader } from "@/components/community/dm-header"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/message-list"
import { Composer } from "@/components/community/composer"
import { ForumView } from "@/components/community/forum-view"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { NewThreadDialog } from "@/components/community/new-thread-panel"
import type { RightPanel, Msg, OpenProfile, Role } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import type { MentionType } from "@alook/shared"

/**
 * /community/channels/:serverId/:channelId
 *
 * - If serverId === "@me": DM conversation view
 * - If server + forum channel: ForumView
 * - If server + text channel: MessageList + Composer + right panels
 * - Thread takeover when a thread is opened
 */
export default function ChannelPage() {
  const params = useParams<{ serverId: string; channelId: string }>()
  const router = useRouter()
  const serverId = decodeURIComponent(params.serverId)
  const isAtMe = serverId === "@me"
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

  const doSearch = useCallback(async (q: string) => {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults([]); return }
    try {
      const params = new URLSearchParams({ q })
      if (!isAtMe && params) params.set("channelId", channelId)
      const data = await apiFetch<{ results: Array<{ message: { id: string; content: string; authorId: string; createdAt: string }; author: { name: string; image: string | null } }> }>(`/api/community/search?${params}`)
      setSearchResults(data.results.map((r) => ({
        id: r.message.id,
        authorName: r.author.name,
        authorAvatar: r.author.image ?? r.author.name.charAt(0).toUpperCase(),
        content: r.message.content,
        createdAt: r.message.createdAt,
      })))
    } catch { setSearchResults([]) }
  }, [isAtMe, channelId])

  // Determine channel type from server categories
  const channelInServer = useMemo(() => {
    if (isAtMe) return null
    const allChannels = ctx.currentServer?.categories?.flatMap((c) => c.channels) ?? []
    return allChannels.find((ch) => ch.id === channelId) ?? null
  }, [isAtMe, ctx.currentServer, channelId])

  const isForum = channelInServer?.type === "forum"
  // If channelId is not in server categories and not @me, it's a child channel (post/thread opened via URL)
  const isChildChannel = !isAtMe && !channelInServer && !!ctx.currentServer?.categories

  // Find the channel name
  const channelName = useMemo(() => {
    if (localName) return localName
    if (isAtMe) {
      return ctx.dms.find((d) => d.id === channelId)?.name ?? "DM"
    }
    if (channelInServer) return channelInServer.name
    // Child channel — use meta from context
    if (ctx.currentChannelMeta?.name) return ctx.currentChannelMeta.name
    const post = ctx.forumPosts.find((p) => p.id === channelId)
    if (post) return post.name
    const thread = ctx.threads.find((t) => t.id === channelId)
    if (thread) return thread.name
    return "channel"
  }, [localName, isAtMe, channelInServer, ctx.dms, ctx.forumPosts, ctx.threads, ctx.currentChannelMeta, channelId])

  // DM object
  const dm = isAtMe ? ctx.dms.find((d) => d.id === channelId) ?? null : null

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

  // DM endpoint ignores mentionType (no roster to fan out to), so the third
  // arg is accepted to match the Composer signature and dropped. Replies are
  // supported — the backend persists `replyToId` for DMs too.
  const sendDmMsg = async (markdown: string, attachments?: File[]) => {
    if (!markdown && !attachments?.length) return
    if (!channelId) return

    // Upload files first if any
    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) => ctx.uploadFile({ dmId: channelId }, f))
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }

    ctx.sendDmMessage(channelId, markdown || "", {
      replyToId: replyTo?.id,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
    setReplyTo(null)
  }

  // ── Send typing ─────────────────────────────────────────────────────────
  const handleTyping = () => {
    if (isAtMe) {
      ctx.sendTyping({ dmConversationId: channelId })
    } else {
      ctx.sendTyping({ channelId })
    }
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
    pinned: ctx.pinned,
    searchResults,
    threads: ctx.threads,
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

  // ── DM view ─────────────────────────────────────────────────────────────
  if (isAtMe && !dm) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <span className="text-sm">{ctx.dmsLoading ? "Loading…" : "Conversation not found"}</span>
      </div>
    )
  }
  if (isAtMe && dm) {
    const dmBlocked = ctx.blocked.some((b) => (b.userId ?? b.id) === dm.userId)
    return (
      <>
        <DmHeader
          dm={dm}
          onBack={bp === "mobile" ? goBack : undefined}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <MessageList
            channel={dm.name}
            messages={ctx.messages}
            typingUsers={ctx.typingUsers.map((id) => ctx.friends.find((f) => f.userId === id)?.name ?? id)}
            onOpenThread={() => {}}
            onToggleReaction={dmBlocked ? undefined : messageActions.onToggleReaction}
            onReact={dmBlocked ? undefined : messageActions.onReact}
            onCopy={messageActions.onCopy}
            onRetry={dmBlocked ? undefined : messageActions.onRetry}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            scrollToMessageId={scrollToMessageId}
            hero={
              <>
                <div className="relative mb-3 w-fit"><Avatar label={dm.avatar} size={68} /></div>
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
              members={ctx.friends}
              onSend={sendDmMsg}
              onTyping={handleTyping}
              replyingTo={replyTo?.authorName}
              onCancelReply={() => setReplyTo(null)}
            />
          )}
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
    let forumTags: string[] = []
    try { forumTags = forumChannel?.forumTags ? JSON.parse(forumChannel.forumTags) : [] } catch { /* malformed JSON */ }
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
