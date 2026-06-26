"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channel-header"
import { DmHeader } from "@/components/community/dm-header"
import { MessageList } from "@/components/community/message-list"
import { Composer } from "@/components/community/composer"
import { DmMessages } from "@/components/community/dm-messages"
import { ForumView } from "@/components/community/forum-view"
import { ThreadHeader } from "@/components/community/thread-header"
import { ThreadMessages } from "@/components/community/thread-messages"
import { RightPanelContent } from "@/components/community/right-panel"
import { NewThreadDialog } from "@/components/community/new-thread-panel"
import { Overlay } from "@/components/community/overlay"
import type { RightPanel, Msg, Thread, OpenProfile } from "@/components/community/_types"

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
  const isAtMe = params.serverId === "@me"
  const channelId = params.channelId
  const bp = useBreakpoint()
  const ctx = useCommunity()

  const openSidebar = useCallback(() => {
    ctx.openSidebar()
  }, [ctx])
  const goBack = useCallback(() => {
    router.push(`/community/channels/${params.serverId}`)
  }, [router, params.serverId])

  // Set the current channel from URL params
  useEffect(() => {
    ctx.setCurrentChannelId(channelId)
    return () => { ctx.setCurrentChannelId(null) }
  }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local UI state ──────────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = useState<RightPanel>("members")
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [creatingThread, setCreatingThread] = useState(false)
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Msg[]>([])

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

  // Determine if current channel is a forum
  const isForum = useMemo(() => {
    if (isAtMe) return false
    const allChannels = ctx.currentServer?.categories.flatMap((c) => c.channels) ?? []
    return allChannels.find((ch) => ch.id === channelId)?.type === "forum"
  }, [isAtMe, ctx.currentServer, channelId])

  // Find the channel name
  const channelName = useMemo(() => {
    if (isAtMe) {
      return ctx.dms.find((d) => d.id === channelId)?.name ?? "DM"
    }
    const allChannels = ctx.currentServer?.categories.flatMap((c) => c.channels) ?? []
    return allChannels.find((ch) => ch.id === channelId)?.name ?? "channel"
  }, [isAtMe, ctx.currentServer, ctx.dms, channelId])

  // DM object
  const dm = isAtMe ? ctx.dms.find((d) => d.id === channelId) ?? null : null

  // Open thread object
  const openThread: Thread | null = useMemo(() => {
    if (!openThreadId) return null
    return ctx.threads.find((t) => t.id === openThreadId)
      ?? ctx.forumPosts.find((p) => p.id === openThreadId)
      ?? null
  }, [openThreadId, ctx.threads, ctx.forumPosts])

  // Pinned message ids
  const pinnedIds = useMemo(() => new Set(ctx.pinned.map((p) => p.id)), [ctx.pinned])

  // ── Panel toggle ────────────────────────────────────────────────────────
  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  const enterThread = (id: string) => {
    setOpenThreadId(id)
    setRightPanel(null)
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
      else ctx.pinMessage(id)
    },
    onCreateThread: (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      const name = (m?.content ?? channelName).split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || channelName
      ctx.createThread(id, name)
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

  // ── Send messages ───────────────────────────────────────────────────────
  const sendMessage = async (markdown: string, attachments?: File[]) => {
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
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
    setReplyTo(null)
  }

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
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
  }

  const sendThreadMsg = async (markdown: string, attachments?: File[]) => {
    if (!markdown && !attachments?.length) return
    if (!openThreadId) return

    // Upload files first if any
    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) => ctx.uploadFile({ threadId: openThreadId }, f))
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }

    ctx.sendThreadMessage(openThreadId, markdown || "", {
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
  }

  // ── Send typing ─────────────────────────────────────────────────────────
  const handleTyping = () => {
    if (isAtMe) {
      ctx.sendTyping({ dmConversationId: channelId })
    } else if (openThreadId) {
      ctx.sendTyping({ threadId: openThreadId })
    } else {
      ctx.sendTyping({ channelId })
    }
  }

  // ── Create thread from dialog ───────────────────────────────────────────
  const createThreadFromDialog = (name: string, firstMessage?: string) => {
    setCreatingThread(false)
    if (firstMessage) {
      // Send a message first, then create a thread from it
      ctx.sendMessage(firstMessage).then(() => {
        // The newest message just got added; create thread from it
        const lastMsg = ctx.messages[ctx.messages.length - 1]
        if (lastMsg) ctx.createThread(lastMsg.id, name)
      })
    } else {
      toast("Create a thread by clicking 'Create Thread' on any message")
    }
  }

  // ── Forum posts ─────────────────────────────────────────────────────────
  const createForumPost = (post: { name: string; content: string; tags: string[] }) => {
    ctx.createForumPost(channelId, post)
  }

  // ── Panel props ─────────────────────────────────────────────────────────
  const panelProps = {
    onOpenThread: enterThread,
    members: ctx.members,
    pinned: ctx.pinned,
    searchResults,
    threads: ctx.threads,
    searchQuery,
  }

  // ── Thread takeover ─────────────────────────────────────────────────────
  if (openThread) {
    return (
      <>
        <ThreadHeader
          thread={openThread}
          channelName={channelName}
          forum={isForum}
          onClose={() => setOpenThreadId(null)}
          onBack={bp === "mobile" ? () => setOpenThreadId(null) : undefined}
          onRename={async (name) => {
            try {
              await apiFetch(`/api/community/threads/${openThread.id}`, {
                method: "PATCH",
                body: JSON.stringify({ name }),
              })
            } catch { toast("Failed to rename thread") }
          }}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <ThreadMessages thread={openThread} onOpenProfile={openProfile} />
          <Composer
            channel={openThread.name}
            thread
            members={ctx.friends}
            onSend={sendThreadMsg}
            onTyping={handleTyping}
          />
        </main>
      </>
    )
  }

  // ── DM view ─────────────────────────────────────────────────────────────
  if (isAtMe && !dm) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <span className="text-sm">Conversation not found</span>
      </div>
    )
  }
  if (isAtMe && dm) {
    return (
      <>
        <DmHeader
          dm={dm}
          onBack={bp === "mobile" ? goBack : undefined}
          onOpenPins={() => setRightPanel("pinned")}
          onAddFriend={() => { ctx.sendFriendRequest(dm.userId); toast("Friend request sent") }}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <DmMessages dm={dm} onOpenProfile={openProfile} />
          <Composer
            channel={dm.name}
            thread
            members={ctx.friends}
            onSend={sendDmMsg}
            onTyping={handleTyping}
          />
        </main>
      </>
    )
  }

  // ── Forum view ──────────────────────────────────────────────────────────
  if (isForum) {
    const allChannels = ctx.currentServer?.categories.flatMap((c) => c.channels) ?? []
    const forumChannel = allChannels.find((ch) => ch.id === channelId)
    let forumTags: string[] = []
    try { forumTags = forumChannel?.forumTags ? JSON.parse(forumChannel.forumTags) : [] } catch { /* malformed JSON */ }
    return (
      <ForumView
        channel={channelName}
        posts={ctx.forumPosts}
        tags={forumTags}
        onOpenPost={enterThread}
        onCreatePost={createForumPost}
        onAttach={() => toast("Attach files when creating a post")}
        onHamburger={bp === "tablet" ? openSidebar : undefined}
        onBack={bp === "mobile" ? goBack : undefined}
      />
    )
  }

  // ── Standard channel view ───────────────────────────────────────────────
  return (
    <>
      <ChannelHeader
        channel={channelName}
        rightPanel={rightPanel}
        onToggle={togglePanel}
        onSearch={(q) => { doSearch(q); setRightPanel("search") }}
        notifLevel={(ctx.channelNotif[channelId] as ChannelNotifLevel) ?? "Use Server Default"}
        onSetNotifLevel={(l) => ctx.setChannelNotif(channelId, l)}
        searchBox={bp !== "mobile"}
        onHamburger={bp === "tablet" ? openSidebar : undefined}
        onBack={bp === "mobile" ? goBack : undefined}
      />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <MessageList
            channel={channelName}
            messages={ctx.messages}
            pinnedIds={pinnedIds}
            typingUsers={ctx.typingUsers.map((id) => ctx.members.find((m) => m.userId === id)?.name ?? id)}
            onOpenThread={enterThread}
            {...messageActions}
            onOpenProfile={openProfile}
          />
          <Composer
            channel={channelName}
            members={ctx.friends}
            onSend={sendMessage}
            onCreateThread={() => setCreatingThread(true)}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
          />
        </main>
        {/* Desktop: inline right panel */}
        {bp === "desktop" && rightPanel && (
          <aside className={`${rightPanel === "members" ? "w-60" : "w-80"} shrink-0 border-l border-border`}>
            <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} {...panelProps} onOpenProfile={openProfile} />
          </aside>
        )}
      </div>

      {/* Tablet/mobile: right panel overlay */}
      {bp === "tablet" && rightPanel && (
        <Overlay onClose={() => setRightPanel(null)} side="right">
          <div className="h-full w-[320px] bg-background shadow-(--e2)">
            <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} showClose {...panelProps} onOpenProfile={openProfile} />
          </div>
        </Overlay>
      )}

      {/* Mobile: full-screen panel */}
      {bp === "mobile" && rightPanel && (
        <div className="absolute inset-0 z-20 bg-background">
          <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} showClose {...panelProps} onOpenProfile={openProfile} />
        </div>
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
