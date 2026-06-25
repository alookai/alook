"use client"

/**
 * Community STYLE PREVIEW — mock data only, fixed URL /d-preview.
 * Not wired to any API. Built to validate the visual direction:
 * community layout + Alook design tokens.
 *
 * Everything resolves through Alook semantic tokens (globals.css) so it
 * adapts to light/dark. The one token Alook lacks — a surface deeper than
 * --sidebar for the server rail — is scoped locally below as --d-rail.
 *
 * Covers two things from the plan:
 *  #1 Three responsive stages — desktop (≥961) / tablet (601–960) / mobile (≤600).
 *  #2 A wider feature showcase — markdown, mentions, system messages, threads,
 *     pinned / search / thread side panels, typing indicator.
 */

import { useEffect, useMemo, useState } from "react"
import type React from "react"
import { toast } from "sonner"
import { ChevronLeft } from "lucide-react"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

// ── Mock data + shared view-model types ──────────────────────────────────
// Data lives in ./_mock (disposable); shared types in @/components/community/_types.
import {
  SERVERS, CATEGORIES, MESSAGES, NEW_DIVIDER_BEFORE, PINNED, SEARCH_RESULTS,
  THREADS, FORUM_POSTS, FORUM_TAGS, MEMBERS, FRIENDS, PENDING, BLOCKED, DMS,
  PROFILES, INVITES, AUDIT_LOG, MENTIONS, INBOX_FEED, FOLDER_SERVERS,
} from "./_mock"
import type { RightPanel, MobileZone, View, SettingsSection, Msg, PendingRequest, BlockedUser, ForumPost, Profile, Thread, Role, DM } from "@/components/community/_types"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { useChannelTree } from "@/components/community/use-channel-tree"
import { ProfileCard } from "@/components/community/profile-card"
import { ImageLightbox } from "@/components/community/image-lightbox"
import { NewThreadDialog } from "@/components/community/new-thread-panel"
import { UserSettings } from "@/components/community/edit-profile-dialog"
import { ServerRail } from "@/components/community/server-rail"
import { MobileRail } from "@/components/community/mobile-rail"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { DmSidebar } from "@/components/community/dm-sidebar"
import { UserBar } from "@/components/community/user-bar"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channel-header"
import { ThreadHeader } from "@/components/community/thread-header"
import { DmHeader } from "@/components/community/dm-header"
import { MessageList } from "@/components/community/message-list"
import { Composer } from "@/components/community/composer"
import { RightPanelContent } from "@/components/community/right-panel"
import { ThreadMessages } from "@/components/community/thread-messages"
import { ForumView } from "@/components/community/forum-view"
import { DmMessages } from "@/components/community/dm-messages"
import { FriendsPage } from "@/components/community/friends-page"
import { ServerSettings } from "@/components/community/server-settings"
import { InboxPopover } from "@/components/community/community-inbox-popover"
import { Shell } from "@/components/community/shell"
import { Overlay } from "@/components/community/overlay"

// ── Page ────────────────────────────────────────────────────────────────
export default function CommunityPreview() {
  const bp = useBreakpoint()
  // channel tree state lives here (single source of truth) so the page can tell whether the
  // active channel is a forum — including channels created at runtime via the sidebar.
  const channelTree = useChannelTree(CATEGORIES)
  const [view, setView] = useState<View>("server")
  const [activeChannel, setActiveChannel] = useState("welcome")
  const [activeDm, setActiveDm] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview")
  const [rightPanel, setRightPanel] = useState<RightPanel>("members")
  // An open thread takes over the message area like a channel.
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false) // tablet left overlay
  const [mobileZone, setMobileZone] = useState<MobileZone>("messages")
  const [profile, setProfile] = useState<{ data: Profile; x: number; y: number } | null>(null)
  // demo state — preview-local; the live app replaces these handlers with API mutations + WS
  const [messages, setMessages] = useState<Msg[]>(MESSAGES)
  const [pinned, setPinned] = useState<Msg[]>(PINNED)
  const [friendList, setFriendList] = useState(FRIENDS)
  const [pending, setPending] = useState<PendingRequest[]>(PENDING)
  const [blocked, setBlocked] = useState<BlockedUser[]>(BLOCKED)
  const [invites, setInvites] = useState(INVITES)
  const [forumPosts, setForumPosts] = useState(FORUM_POSTS)
  const [threads, setThreads] = useState(THREADS)
  const [dmList, setDmList] = useState<DM[]>(DMS)
  const [memberList, setMemberList] = useState(MEMBERS)
  const [serverName, setServerName] = useState("Alook")
  const [notifLevel, setNotifLevel] = useState("Only @mentions")
  const [channelNotif, setChannelNotif] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const cat of CATEGORIES) for (const ch of cat.channels) if (ch.muted) init[ch.id] = "Nothing"
    return init
  })
  const [myAboutMe, setMyAboutMe] = useState("Building Alook. Coffee, agents, and warm gray UIs.")
  const [editingProfile, setEditingProfile] = useState(false)
  // when set, the message area shows the "New Thread" creation panel
  const [creatingThread, setCreatingThread] = useState(false)
  // reply target (message being replied to) — drives the composer quote bar
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)
  // search query submitted from the channel header (opens the search panel pre-filled)
  const [searchQuery, setSearchQuery] = useState("")
  // image attachment being previewed in the lightbox
  const [preview, setPreview] = useState<string | null>(null)
  // avoid hydration mismatch: theme is unknown on the server
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [inboxFeed, setInboxFeed] = useState(INBOX_FEED)

  // inbox item / mention → jump to the server + a channel (front-end nav) + mark read
  const openInboxItem = (id: string) => {
    setInboxFeed((prev) => prev.map((f) => f.id === id ? { ...f, unread: false } : f))
    setView("server")
    setActiveChannel("general")
    setOpenThreadId(null)
    if (bp === "mobile") setMobileZone("messages")
  }

  // shell chrome — app name + inbox popover slot
  const shellProps = {
    appName: "Alook",
    inbox: <InboxPopover feed={inboxFeed} mentions={MENTIONS} onOpenItem={openInboxItem} onMarkAllRead={() => setInboxFeed((prev) => prev.map((f) => ({ ...f, unread: false })))} />,
    hasUnread: inboxFeed.some((f) => f.unread),
  }

  // open a profile card near the click point (desktop popover / mobile sheet).
  // Every member is clickable — fall back to a profile built from the member/friend
  // record when there's no curated PROFILES entry (the live app always has one).
  const openProfile = (name: string, e: React.MouseEvent) => {
    const member = memberList.find((m) => m.name === name)
      ?? friendList.find((f) => f.name === name)
    let data: Profile = PROFILES[name] ?? {
      name,
      avatar: member?.avatar ?? name.charAt(0).toUpperCase(),
      role: "Member",
      about: member && "sub" in member && member.sub ? member.sub : "No bio yet.",
      mutual: 1,
      tags: ["Member"],
    }
    if (name === "Gener") data = { ...data, about: myAboutMe }
    setProfile({ data, x: e.clientX, y: e.clientY })
  }
  const profileProps = { onOpenProfile: openProfile }
  let msgSeq = messages.length

  // message from profile card — find or create a DM, append the message, and navigate
  const profileMessage = (name: string, text: string) => {
    let target = dmList.find((d) => d.name === name)
    if (!target) {
      target = { id: `dm_${name.toLowerCase()}`, userId: `u_${name.toLowerCase()}`, name, avatar: name.charAt(0).toUpperCase(), status: "online" as const, preview: text.slice(0, 40), messages: [] }
      setDmList((prev) => [target!, ...prev])
    }
    setDmList((prev) => prev.map((d) => d.id !== target!.id ? d : {
      ...d, preview: text.slice(0, 40),
      messages: [...d.messages, { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: text }],
    }))
    setView("dm")
    setActiveDm(target!.id)
    setProfile(null)
    if (bp === "mobile") setMobileZone("messages")
  }

  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  // the active channel object (for forum detection) and the open thread/post.
  const activeChannelObj = Object.values(channelTree.order).flat().find((ch) => ch.id === activeChannel)
  const isForum = activeChannelObj?.type === "forum"
  const allThreads = [...threads, ...Object.values(forumPosts).flat()]
  const openThread = allThreads.find((t) => t.id === openThreadId) ?? null
  const dm = dmList.find((d) => d.id === activeDm) ?? null

  // header button → channel thread list (side panel); picking one → full message area.
  // also used to open a forum post (forum posts share the Thread shape).
  const enterThread = (id: string) => {
    setOpenThreadId(id)
    setRightPanel(null)
    if (bp === "mobile") setMobileZone("messages")
  }

  // rail: @me → DM/Friends view; a server → server view
  const goHome = () => { setView("dm"); setActiveDm(null); setOpenThreadId(null); if (bp === "mobile") setMobileZone("channels") }
  const goServer = () => { setView("server"); setOpenThreadId(null); if (bp === "mobile") setMobileZone("channels") }

  const enterDm = (id: string) => {
    setActiveDm(id)
    setDmList((prev) => prev.map((d) => d.id === id ? { ...d, unread: false } : d))
    if (bp === "tablet") setSidebarOpen(false)
    if (bp === "mobile") setMobileZone("messages")
  }

  // create a thread (local) and open it.
  //  - `anchor` (from a message) becomes the thread's first message.
  //  - otherwise `firstMessage` (from the New Thread panel) seeds an optional opener.
  let threadSeq = 0
  const createThread = (name: string, opts?: { firstMessage?: string; anchor?: Msg }) => {
    const id = `thr_local_${++threadSeq}`
    const seed: Msg[] = opts?.anchor
      ? [opts.anchor]
      : opts?.firstMessage
        ? [{ id: `${id}_1`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: opts.firstMessage }]
        : []
    const t: Thread = {
      id, name, messageCount: seed.length, lastMessageAt: new Date().toISOString(),
      parent: {
        authorName: opts?.anchor?.authorName ?? "Gener",
        text: opts?.anchor?.content ?? name,
      },
      messages: seed,
    }
    setThreads((prev) => [t, ...prev])
    setCreatingThread(false)
    enterThread(id)
  }
  // from a message — the message anchors the thread (its first message); name defaults
  // to the message's first words.
  const createThreadFromMessage = (id: string) => {
    const m = messages.find((x) => x.id === id)
    const name = (m?.content ?? activeChannel).split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || activeChannel
    createThread(name, m ? { anchor: m } : undefined)
  }

  // send a channel message — append to the local list (live app: POST + WS echo)
  const sendMessage = (markdown: string) => {
    if (!markdown) return
    setMessages((prev) => [
      ...prev,
      {
        id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(),
        content: markdown, ...(replyTo ? { replyTo } : {}),
      },
    ])
    setReplyTo(null)
  }

  // send into the open thread — appends to the thread's message array (live: POST to thread)
  const sendThreadMessage = (markdown: string) => {
    if (!markdown || !openThreadId) return
    setThreads((prev) => prev.map((t) => t.id !== openThreadId ? t : {
      ...t,
      messageCount: t.messageCount + 1,
      lastMessageAt: new Date().toISOString(),
      messages: [...t.messages, { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: markdown }],
    }))
    setForumPosts((prev) => {
      const next = { ...prev }
      for (const [ch, posts] of Object.entries(next))
        next[ch] = posts.map((p) => p.id !== openThreadId ? p : {
          ...p, messageCount: p.messageCount + 1, lastMessageAt: new Date().toISOString(),
          messages: [...p.messages, { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: markdown }],
        })
      return next
    })
  }

  // send into a DM conversation
  const sendDmMessage = (markdown: string) => {
    if (!markdown || !activeDm) return
    setDmList((prev) => prev.map((d) => d.id !== activeDm ? d : {
      ...d,
      preview: markdown.slice(0, 40),
      messages: [...d.messages, { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: markdown }],
    }))
  }

  // reaction toggle — flip `me` and inc/dec count; add the emoji if it's new
  const toggleReaction = (id: string, emoji: string) =>
    setMessages((prev) => prev.map((m) => {
      if (m.id !== id) return m
      const existing = m.reactions?.find((r) => r.emoji === emoji)
      if (!existing) return { ...m, reactions: [...(m.reactions ?? []), { emoji, count: 1, me: true }] }
      const reactions = m.reactions!
        .map((r) => r.emoji === emoji ? { ...r, me: !r.me, count: r.count + (r.me ? -1 : 1) } : r)
        .filter((r) => r.count > 0)
      return { ...m, reactions }
    }))


  // retry a failed send — clear the failed flag (live app: re-POST)
  const retryMessage = (id: string) =>
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, failed: false } : m))
  // copy message text to the clipboard
  const copyMessage = (id: string) => {
    const m = messages.find((x) => x.id === id)
    if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
  }
  // reply — set the composer's reply target from the message
  const replyToMessage = (id: string) => {
    const m = messages.find((x) => x.id === id)
    if (m) setReplyTo({ id: m.id, authorName: m.authorName ?? "", text: m.content ?? "" })
  }
  // pinned message ids — drives the Pin/Unpin menu label on each message row
  const pinnedIds = useMemo(() => new Set(pinned.map((p) => p.id)), [pinned])
  // pin — toggle the message in the local pinned set (shown in the Pinned panel)
  const pinMessage = (id: string) => {
    const m = messages.find((x) => x.id === id)
    if (!m) return
    const wasPinned = pinned.some((p) => p.id === id)
    setPinned((prev) => wasPinned ? prev.filter((p) => p.id !== id) : [m, ...prev])
    toast(wasPinned ? "Message unpinned" : "Message pinned")
  }

  const messageActions = {
    onToggleReaction: toggleReaction,
    onReact: toggleReaction,
    onReply: replyToMessage,
    onPin: pinMessage,
    onCreateThread: createThreadFromMessage,
    onCopy: copyMessage,
    onRetry: retryMessage,
    onPreviewImage: (name: string) => setPreview(name),
    onDownloadFile: (name: string) => toast(`Downloading ${name}`),
  }

  // member actions — change role / kick (real local-state mutations). Owner is fixed:
  // the UI never offers it, and we guard here too.
  const setMemberRole = (name: string, role: Role) => {
    setMemberList((prev) => prev.map((m) => m.name === name && m.role !== "Owner" ? { ...m, role } : m))
    toast(`${name} is now ${role}`)
  }
  const kickMember = (name: string) => {
    setMemberList((prev) => prev.filter((m) => m.name !== name || m.role === "Owner"))
    toast(`${name} kicked`)
  }
  const memberActions = { onSetRole: setMemberRole, onKickMember: kickMember }

  // friend request actions — move rows between pending/blocked locally
  const friendActions = {
    onAccept: (id: string) => { const req = pending.find((r) => r.id === id); setPending((p) => p.filter((r) => r.id !== id)); if (req) setFriendList((p) => [...p, { id: `fr_${req.id}`, name: req.name, avatar: req.avatar, status: "online", sub: "" }]); toast("Friend request accepted") },
    onReject: (id: string) => setPending((p) => p.filter((r) => r.id !== id)),
    onCancelRequest: (id: string) => setPending((p) => p.filter((r) => r.id !== id)),
    onUnblock: (id: string) => { setBlocked((b) => b.filter((u) => u.id !== id)); toast("User unblocked") },
    onSendRequest: (username: string) => { setPending((p) => [...p, { id: `pr_${username}`, name: username, avatar: username.charAt(0).toUpperCase(), kind: "outgoing" }]); toast(`Friend request sent to ${username}`) },
    onRemoveFriend: (id: string) => { setFriendList((p) => p.filter((f) => f.id !== id)); toast("Friend removed") },
    onBlock: (id: string) => { const f = friendList.find((x) => x.id === id); setFriendList((p) => p.filter((x) => x.id !== id)); if (f) setBlocked((b) => [...b, { id: f.id, name: f.name, avatar: f.avatar }]); toast("User blocked") },
  }

  // server-settings actions — list deletions mutate local state; copy hits the clipboard.
  // Member role/kick reuse the shared member actions (same state as the member list).
  const settingsActions = {
    onKickMember: kickMember,
    onSetRole: setMemberRole,
    onRevokeInvite: (code: string) => { setInvites((p) => p.filter((iv) => iv.code !== code)); toast("Invite revoked") },
    onCreateInvite: () => { const code = Math.random().toString(36).slice(2, 8); setInvites((p) => [{ code, by: "Gener", uses: 0, maxUses: null, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() }, ...p]); toast("Invite created") },
    onCopyInvite: (code: string) => { navigator.clipboard?.writeText(`/community/invite/${code}`); toast("Invite copied") },
    onDeleteServer: () => { toast("Server deleted"); goHome() },
    onUploadIcon: () => toast("Upload a server icon"),
    onUpdateServer: (name: string, _desc: string) => { setServerName(name); toast("Server updated") },
    notifLevel,
    onSetNotifLevel: setNotifLevel,
  }

  // create a forum post — prepend to the active channel's feed (live app: POST → thread)
  let postSeq = 0
  const createForumPost = (post: { name: string; content: string; tags: string[] }) => {
    const id = `fp_local_${++postSeq}`
    const created: ForumPost = {
      id, name: post.name, authorAvatar: "G", messageCount: 1, lastMessageAt: new Date().toISOString(),
      tags: post.tags, preview: post.content || "(no description)",
      parent: { authorName: "Gener", text: post.content || post.name },
      messages: [{ id: `${id}_1`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: post.content || post.name }],
    }
    setForumPosts((prev) => ({ ...prev, [activeChannel]: [created, ...(prev[activeChannel] ?? [])] }))
    toast(`Posted “${post.name}”`)
  }

  const panelProps = {
    onOpenThread: enterThread, members: memberList, pinned, searchResults: SEARCH_RESULTS, threads,
    searchQuery,
    ...memberActions,
  }

  const railProps = {
    servers: SERVERS, folderServers: FOLDER_SERVERS, setMobileZone, view, onHome: goHome, onServer: goServer,
    onCreateServer: (name: string) => toast(name ? `Server "${name}" created` : "Server created"),
    onJoinServer: () => toast("Joined server"),
    onLeaveServer: () => { toast("Left server"); goHome() },
  }
  const channelProps = {
    tree: channelTree,
    serverName,
    activeChannel,
    setActiveChannel: (id: string) => {
      setActiveChannel(id)
      channelTree.markRead(id)
      setOpenThreadId(null)
      if (bp === "tablet") setSidebarOpen(false)
      if (bp === "mobile") setMobileZone("messages")
    },
    onOpenSettings: () => setView("settings"),
    onBlockedCreate: () => toast("Only admins can create channels in a private category"),
    mutedChannels: Object.fromEntries(Object.entries(channelNotif).map(([k, v]) => [k, v === "Nothing"])),
  }

  // The left sidebar — channels (server view) or DM list (@me view).
  const sidebar = (opts: { bordered?: boolean; noHeader?: boolean } = {}) =>
    view === "dm" ? (
      <DmSidebar dms={dmList} activeDm={activeDm} onPickDm={enterDm} onShowFriends={() => setActiveDm(null)} {...opts} />
    ) : (
      <ChannelSidebar {...channelProps} {...opts} />
    )

  // The whole content column (header + body). Branches: open thread → thread takeover;
  // @me view → DM conversation or Friends page; server view → channel + right panel.
  const contentColumn = ({ compact, hamburger }: { compact?: boolean; hamburger?: boolean } = {}) => {

    if (openThread)
      return (
        <>
          <ThreadHeader thread={openThread} channelName={activeChannel} forum={isForum} onClose={() => setOpenThreadId(null)} onBack={compact ? () => setMobileZone("channels") : undefined} onRename={(name) => { setThreads((p) => p.map((t) => t.id === openThreadId ? { ...t, name } : t)); setForumPosts((p) => { const next = { ...p }; for (const [ch, posts] of Object.entries(next)) next[ch] = posts.map((fp) => fp.id === openThreadId ? { ...fp, name } : fp); return next }) }} />
          <main className="flex min-h-0 flex-1 flex-col">
            <ThreadMessages thread={openThread} {...profileProps} />
            <Composer channel={openThread.name} thread members={friendList} onSend={sendThreadMessage} />
          </main>
        </>
      )

    if (view === "dm")
      return dm ? (
        <>
          <DmHeader dm={dm} onBack={compact ? () => setMobileZone("channels") : undefined} onOpenPins={() => setRightPanel("pinned")} onAddFriend={() => { if (!friendList.some((f) => f.name === dm.name)) setFriendList((p) => [...p, { id: `fr_${dm.id}`, name: dm.name, avatar: dm.avatar, status: dm.status, sub: "" }]); toast(`Added ${dm.name} as a friend`) }} />
          <main className="flex min-h-0 flex-1 flex-col">
            <DmMessages dm={dm} {...profileProps} />
            <Composer channel={dm.name} thread members={friendList} onSend={sendDmMessage} />
          </main>
        </>
      ) : (
        <FriendsPage friends={friendList} pending={pending} blocked={blocked} onBack={compact ? () => setMobileZone("channels") : undefined} hamburger={hamburger ? () => setSidebarOpen(true) : undefined} {...friendActions} {...profileProps} />
      )

    // forum channel → post list (a forum is a feed of threads, not a chat)
    if (isForum)
      return (
        <ForumView
          channel={activeChannel}
          posts={forumPosts[activeChannel] ?? []}
          tags={FORUM_TAGS}
          onOpenPost={enterThread}
          onCreatePost={createForumPost}
          onAttach={() => toast("Attach an image")}
          onHamburger={hamburger ? () => setSidebarOpen(true) : undefined}
          onBack={compact ? () => setMobileZone("channels") : undefined}
        />
      )

    return (
      <>
        <ChannelHeader
          channel={activeChannel}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          onSearch={(q) => { setSearchQuery(q); setRightPanel("search") }}
          notifLevel={(channelNotif[activeChannel] as ChannelNotifLevel) ?? "Use Server Default"}
          onSetNotifLevel={(l) => setChannelNotif((p) => ({ ...p, [activeChannel]: l }))}
          searchBox={bp !== "mobile"}
          onHamburger={hamburger ? () => setSidebarOpen(true) : undefined}
          onBack={compact ? () => setMobileZone("channels") : undefined}
        />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <MessageList channel={activeChannel} messages={messages} pinnedIds={pinnedIds} newDividerBefore={NEW_DIVIDER_BEFORE} typingUsers={["Lindsay"]} onOpenThread={enterThread} {...messageActions} {...profileProps} />
            <Composer channel={activeChannel} members={friendList} onSend={sendMessage} onCreateThread={() => setCreatingThread(true)} replyingTo={replyTo?.authorName} onCancelReply={() => setReplyTo(null)} />
          </main>
          {/* desktop renders the panel inline; tablet/mobile use overlays below */}
          {bp === "desktop" && rightPanel && (
            <aside className={`${rightPanel === "members" ? "w-60" : "w-80"} shrink-0 border-l border-border`}>
              <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} {...panelProps} {...profileProps} />
            </aside>
          )}
        </div>
      </>
    )
  }

  // portaled dialogs — rendered in every layout branch
  const dialogs = (
    <>
      <NewThreadDialog channel={activeChannel} open={creatingThread} onClose={() => setCreatingThread(false)} onCreate={(name, firstMessage) => createThread(name, { firstMessage })} />
      <Dialog open={editingProfile} onOpenChange={(o) => { if (!o) setEditingProfile(false) }}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
          <UserSettings onClose={() => setEditingProfile(false)} aboutMe={myAboutMe} onSave={setMyAboutMe} onLogout={() => toast("Logged out")} />
        </DialogContent>
      </Dialog>
      <Dialog open={view === "settings"} onOpenChange={(o) => { if (!o) goServer() }}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
          <ServerSettings section={settingsSection} setSection={setSettingsSection} onClose={goServer} serverName={serverName} serverDescription="Your Personal Company — AI agents that collaborate, always on." members={memberList} invites={invites} auditLog={AUDIT_LOG} {...settingsActions} {...profileProps} />
        </DialogContent>
      </Dialog>
    </>
  )


  // ── Desktop: full 4-column resizable shell ──
  if (bp === "desktop") {
    return (
      <Shell {...shellProps}>
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="24%" minSize="20%" maxSize="36%" className="flex flex-col" style={{ background: "var(--d-rail)" }}>
            <div className="flex min-h-0 flex-1">
              <ServerRail {...railProps} />
              {sidebar({ bordered: true })}
            </div>
            <UserBar user={{ name: "Gener", avatar: "G" }} mounted={mounted} {...profileProps} onEditProfile={() => setEditingProfile(true)} />
          </ResizablePanel>

          <ResizableHandle className="bg-transparent" />

          <ResizablePanel defaultSize="76%" className="flex min-w-0 flex-col border-t border-r border-border bg-sidebar">
            {contentColumn()}
          </ResizablePanel>
        </ResizablePanelGroup>
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === "Gener"} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {dialogs}
      </Shell>
    )
  }

  // ── Tablet: rail + messages, sidebar & right panel as scrim overlays ──
  if (bp === "tablet") {
    return (
      <Shell {...shellProps}>
        <div className="flex min-h-0 flex-1" style={{ background: "var(--d-rail)" }}>
          <ServerRail {...railProps} />
          <div className="flex min-w-0 flex-1 flex-col rounded-tl-xl border-l border-t border-r border-border bg-sidebar">
            {contentColumn({ hamburger: true })}
          </div>
        </div>

        {/* left overlay: channel / DM sidebar */}
        {sidebarOpen && (
          <Overlay onClose={() => setSidebarOpen(false)} side="left">
            <div className="flex h-full w-70 flex-col" style={{ background: "var(--d-rail)" }}>
              <div className="flex min-h-0 flex-1">
                {sidebar()}
              </div>
              <UserBar user={{ name: "Gener", avatar: "G" }} mounted={mounted} {...profileProps} onEditProfile={() => setEditingProfile(true)} />
            </div>
          </Overlay>
        )}

        {/* right overlay: members / pinned / search / thread */}
        {rightPanel && view === "server" && !openThread && (
          <Overlay onClose={() => setRightPanel(null)} side="right">
            <div className="h-full w-[320px] bg-background shadow-(--e2)">
              <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} showClose {...panelProps} {...profileProps} />
            </div>
          </Overlay>
        )}
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === "Gener"} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {dialogs}
      </Shell>
    )
  }

  // ── Mobile: single-zone stack navigation ──
  return (
    <Shell {...shellProps}>
      {mobileZone === "rail" && (
        <MobileRail servers={SERVERS} folderServers={FOLDER_SERVERS} onPick={() => setMobileZone("channels")} onHome={goHome} onServer={goServer} onAddServer={railProps.onCreateServer} onJoinServer={railProps.onJoinServer} view={view} />
      )}

      {mobileZone === "channels" && (
        <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--d-rail)" }}>
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
            <Button variant="ghost" size="icon-sm" onClick={() => setMobileZone("rail")} className="text-muted-foreground hover:text-foreground" aria-label="Back to servers"><ChevronLeft className="size-5" /></Button>
            <span className="ml-1 truncate text-base font-semibold">{view === "dm" ? "Direct Messages" : serverName}</span>
          </header>
          <div className="flex min-h-0 flex-1">
            {sidebar({ noHeader: true })}
          </div>
          <UserBar user={{ name: "Gener", avatar: "G" }} mounted={mounted} {...profileProps} onEditProfile={() => setEditingProfile(true)} />
        </div>
      )}

      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
          {contentColumn({ compact: true })}
        </div>
      )}

      {/* full-screen panel overlay */}
      {rightPanel && view === "server" && !openThread && (
        <div className="absolute inset-0 z-20 bg-background">
          <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} showClose {...panelProps} {...profileProps} />
        </div>
      )}
      {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === "Gener"} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {dialogs}
    </Shell>
  )
}
