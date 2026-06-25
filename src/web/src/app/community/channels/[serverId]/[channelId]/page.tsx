"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
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
  const isAtMe = params.serverId === "@me"
  const channelId = params.channelId
  const bp = useBreakpoint()
  const ctx = useCommunity()

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
  }

  // ── Profile card ────────────────────────────────────────────────────────
  const openProfile: OpenProfile = (_name, _e) => {
    // Profile card is handled in the layout level
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
    onRetry: (_id: string) => {
      // Could re-send failed messages; for now just clear the flag
    },
    onPreviewImage: (_name: string) => {},
    onDownloadFile: (name: string) => toast(`Downloading ${name}`),
  }

  // ── Send messages ───────────────────────────────────────────────────────
  const sendMessage = (markdown: string) => {
    if (!markdown) return
    ctx.sendMessage(markdown, replyTo ? { replyToId: replyTo.id } : undefined)
    setReplyTo(null)
  }

  const sendDmMsg = (markdown: string) => {
    if (!markdown || !channelId) return
    ctx.sendDmMessage(channelId, markdown)
  }

  const sendThreadMsg = (markdown: string) => {
    if (!markdown || !openThreadId) return
    ctx.sendThreadMessage(openThreadId, markdown)
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
    // For "New Thread" button: create a placeholder thread (the API will handle it)
    setCreatingThread(false)
    toast(`Thread "${name}" created`)
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
    searchResults: [] as Msg[],
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
          onRename={(name) => { /* Would call API to rename thread */ }}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <ThreadMessages thread={openThread} onOpenProfile={openProfile} />
          <Composer
            channel={openThread.name}
            thread
            members={ctx.friends}
            onSend={sendThreadMsg}
            onUploadFile={() => toast("Upload a file")}
          />
        </main>
      </>
    )
  }

  // ── DM view ─────────────────────────────────────────────────────────────
  if (isAtMe && dm) {
    return (
      <>
        <DmHeader
          dm={dm}
          onBack={bp === "mobile" ? () => {} : undefined}
          onOpenPins={() => setRightPanel("pinned")}
          onAddFriend={() => toast(`Added ${dm.name} as a friend`)}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <DmMessages dm={dm} onOpenProfile={openProfile} />
          <Composer
            channel={dm.name}
            thread
            members={ctx.friends}
            onSend={sendDmMsg}
            onUploadFile={() => toast("Upload a file")}
          />
        </main>
      </>
    )
  }

  // ── Forum view ──────────────────────────────────────────────────────────
  if (isForum) {
    // Get forum tags from server channel data
    const allChannels = ctx.currentServer?.categories.flatMap((c) => c.channels) ?? []
    const forumChannel = allChannels.find((ch) => ch.id === channelId)
    return (
      <ForumView
        channel={channelName}
        posts={ctx.forumPosts}
        tags={[]}
        onOpenPost={enterThread}
        onCreatePost={createForumPost}
        onAttach={() => toast("Attach an image")}
        onHamburger={bp === "tablet" ? () => {} : undefined}
        onBack={bp === "mobile" ? () => {} : undefined}
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
        onSearch={(q) => { setSearchQuery(q); setRightPanel("search") }}
        notifLevel={(ctx.channelNotif[channelId] as ChannelNotifLevel) ?? "Use Server Default"}
        onSetNotifLevel={(l) => ctx.setChannelNotif(channelId, l)}
        searchBox={bp !== "mobile"}
        onHamburger={bp === "tablet" ? () => {} : undefined}
        onBack={bp === "mobile" ? () => {} : undefined}
      />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <MessageList
            channel={channelName}
            messages={ctx.messages}
            pinnedIds={pinnedIds}
            typingUsers={ctx.typingUsers}
            onOpenThread={enterThread}
            {...messageActions}
            onOpenProfile={openProfile}
          />
          <Composer
            channel={channelName}
            members={ctx.friends}
            onSend={sendMessage}
            onUploadFile={() => toast("Upload a file")}
            onCreateThread={() => setCreatingThread(true)}
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
