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
 *  #1 Two responsive stages — desktop (≥640) / mobile (<640).
 *  #2 A wider feature showcase — markdown, mentions, system messages, threads,
 *     pinned / search / thread side panels, typing indicator.
 */

import { useMemo, useState } from "react"
import type React from "react"
import { toast } from "sonner"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Dialog, DialogContent } from "@/components/ui/dialog"

// ── Mock data + shared view-model types ──────────────────────────────────
// Data lives in ./_mock (disposable); shared types in @/components/community/_types.
import {
  SERVERS, CATEGORIES, MESSAGES, NEW_DIVIDER_BEFORE, PINNED, SEARCH_RESULTS,
  THREADS, THREAD_MESSAGES, FORUM_POSTS, FORUM_TAGS, MEMBERS, FRIENDS, PENDING, BLOCKED, DMS, DM_MESSAGES,
  PROFILES, INVITES, AUDIT_LOG, MENTIONS, FOR_YOU_FEED, UNREAD_SERVERS, MOCK_FOLDERS,
} from "./_mock"
import type { RightPanel, MobileZone, View, SettingsSection, Msg, PendingRequest, BlockedUser, ForumPost, Profile, Thread, Role, DM, Member } from "@/components/community/_types"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelTree } from "@/components/community/use-channel-tree"
import { ProfileCard } from "@/components/community/profile-card"
import { ImageLightbox } from "@/components/community/image-lightbox"
import { NewThreadDialog } from "@/components/community/new-thread-panel"
import { UserSettings } from "@/components/community/edit-profile-dialog"
import { ServerRail } from "@/components/community/server-rail"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { DmSidebar } from "@/components/community/dm-sidebar"
import { UserBar } from "@/components/community/user-bar"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channel-header"
import { DmHeader } from "@/components/community/dm-header"
import { MessageList } from "@/components/community/message-list"
import { Composer } from "@/components/community/composer"
import { CommunityPanelSheet } from "@/components/community/community-panel-sheet"
import { ForumView } from "@/components/community/forum-view"
import { Avatar } from "@/components/community/avatar"
import { FriendsPage } from "@/components/community/friends-page"
import { ServerSettings } from "@/components/community/server-settings"
import { InboxPopover } from "@/components/community/community-inbox-popover"
import { Shell } from "@/components/community/shell"

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
  // Per-surface message streams. Mirrors the live app, where opening a DM or
  // child channel loads its messages into `ctx.messages`; here we keep them
  // keyed by surface id so each takeover view reads from the same shape.
  const [threadMessages, setThreadMessages] = useState<Record<string, Msg[]>>(THREAD_MESSAGES)
  const [dmMessages, setDmMessages] = useState<Record<string, Msg[]>>(DM_MESSAGES)
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
  const [searchQuery] = useState("")
  // image attachment being previewed in the lightbox
  const [preview, setPreview] = useState<string | null>(null)
  const [forYouFeed, setForYouFeed] = useState(FOR_YOU_FEED)
  const [unreadFeed] = useState(UNREAD_SERVERS)

  // open an inbox event → jump to its server + channel
  const openServerChannel = (_sid: string, cid: string) => {
    setView("server")
    setActiveChannel(cid)
    setOpenThreadId(null)
    if (bp === "mobile") setMobileZone("messages")
  }

  // shell chrome — app name + inbox popover slot
  const shellProps = {
    appName: "Alook",
    inbox: (
      <InboxPopover
        forYou={forYouFeed}
        unreads={unreadFeed}
        mentions={MENTIONS}
        onOpenEvent={(e) => openServerChannel(e.serverId, e.channelId)}
        onOpenChannel={openServerChannel}
        onDismissEvent={(eventKey) => setForYouFeed((prev) => prev.filter((e) => e.eventKey !== eventKey))}
        onMarkAllRead={() => setForYouFeed([])}
      />
    ),
    hasUnread: forYouFeed.length > 0 || unreadFeed.length > 0 || MENTIONS.length > 0,
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
      role: "member",
      about: member && "sub" in member && member.sub ? member.sub : "No bio yet.",
      mutual: 1,
      tags: [],
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
      target = { id: `dm_${name.toLowerCase()}`, userId: `u_${name.toLowerCase()}`, name, avatar: name.charAt(0).toUpperCase(), status: "online" as const, preview: text.slice(0, 40) }
      setDmList((prev) => [target!, ...prev])
    }
    const dmId = target.id
    setDmList((prev) => prev.map((d) => d.id !== dmId ? d : { ...d, preview: text.slice(0, 40) }))
    setDmMessages((prev) => ({
      ...prev,
      [dmId]: [...(prev[dmId] ?? []), { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: text }],
    }))
    setView("dm")
    setActiveDm(dmId)
    setProfile(null)
    if (bp === "mobile") setMobileZone("messages")
  }

  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  // Preview @-mention candidate pool. In the live app the composer's roster
  // is the enriched server `members` array (`Member[]`). This mock reshapes
  // `friendList` (a `Friend[]`) into `Member[]` by tacking on the two fields
  // that `Member` adds — a `role` and the (unused-by-popup) `userId` echoing
  // `id`. Keeps the preview visually identical without polluting `_mock.ts`.
  const composerMembers = useMemo<Member[]>(
    () => friendList.map((f) => ({ ...f, userId: f.userId ?? f.id, role: "member" as const })),
    [friendList],
  )

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
  const goHome = () => { setView("dm"); setActiveDm(null); setOpenThreadId(null); if (bp === "mobile") setMobileZone("nav") }
  const goServer = () => { setView("server"); setOpenThreadId(null); if (bp === "mobile") setMobileZone("nav") }

  const enterDm = (id: string) => {
    setActiveDm(id)
    setDmList((prev) => prev.map((d) => d.id === id ? { ...d, unread: false } : d))
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
    }
    setThreads((prev) => [t, ...prev])
    setThreadMessages((prev) => ({ ...prev, [id]: seed }))
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

  // send into the open thread — appends to the thread's message stream (live: POST to thread)
  const sendThreadMessage = (markdown: string) => {
    if (!markdown || !openThreadId) return
    const tid = openThreadId
    const now = new Date().toISOString()
    setThreadMessages((prev) => ({
      ...prev,
      [tid]: [...(prev[tid] ?? []), { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: now, content: markdown }],
    }))
    setThreads((prev) => prev.map((t) => t.id !== tid ? t : { ...t, messageCount: t.messageCount + 1, lastMessageAt: now }))
    setForumPosts((prev) => {
      const next = { ...prev }
      for (const [ch, posts] of Object.entries(next))
        next[ch] = posts.map((p) => p.id !== tid ? p : { ...p, messageCount: p.messageCount + 1, lastMessageAt: now })
      return next
    })
  }

  // send into a DM conversation
  const sendDmMessage = (markdown: string) => {
    if (!markdown || !activeDm) return
    const dmId = activeDm
    setDmList((prev) => prev.map((d) => d.id !== dmId ? d : { ...d, preview: markdown.slice(0, 40) }))
    setDmMessages((prev) => ({
      ...prev,
      [dmId]: [...(prev[dmId] ?? []), { id: `m_local_${++msgSeq}`, authorName: "Gener", authorAvatar: "G", createdAt: new Date().toISOString(), content: markdown }],
    }))
  }

  // reaction toggle — flip `me` and inc/dec count; add the emoji if it's new
  const toggleReaction = (id: string, emoji: string) =>
    setMessages((prev) => prev.map((m) => {
      if (m.id !== id) return m
      const existing = m.reactions?.find((r) => r.emoji === emoji)
      if (!existing) return { ...m, reactions: [...(m.reactions ?? []), { emoji, count: 1, me: true, userIds: ["u_gener"] }] }
      const reactions = m.reactions!
        .map((r) => {
          if (r.emoji !== emoji) return r
          const userIds = r.me ? (r.userIds ?? []).filter((uid) => uid !== "u_gener") : [...(r.userIds ?? []), "u_gener"]
          return { ...r, me: !r.me, count: userIds.length, userIds }
        })
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
    setMemberList((prev) => prev.map((m) => m.name === name && m.role !== "owner" ? { ...m, role } : m))
    toast(`${name} is now ${role}`)
  }
  const kickMember = (name: string) => {
    setMemberList((prev) => prev.filter((m) => m.name !== name || m.role === "owner"))
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
    onCopyInvite: (code: string) => { navigator.clipboard?.writeText(`/community/invite/${code}`); toast("Invite copied") },
    onDeleteServer: () => { toast("Server deleted"); goHome() },
    onUploadIcon: () => toast("Upload a server icon"),
    onUpdateServer: (name: string) => { setServerName(name); toast("Server updated") },
    notifLevel,
    onSetNotifLevel: setNotifLevel,
  }

  // create a forum post — prepend to the active channel's feed (live app: POST → thread)
  let postSeq = 0
  const createForumPost = (post: { name: string; content: string; tags: string[] }) => {
    const id = `fp_local_${++postSeq}`
    const now = new Date().toISOString()
    const created: ForumPost = {
      id, name: post.name, authorAvatar: "G", messageCount: 1, lastMessageAt: now,
      tags: post.tags, preview: post.content || "(no description)",
      parent: { authorName: "Gener", text: post.content || post.name },
    }
    setForumPosts((prev) => ({ ...prev, [activeChannel]: [created, ...(prev[activeChannel] ?? [])] }))
    setThreadMessages((prev) => ({
      ...prev,
      [id]: [{ id: `${id}_1`, authorName: "Gener", authorAvatar: "G", createdAt: now, content: post.content || post.name }],
    }))
    toast(`Posted “${post.name}”`)
  }

  const panelProps = {
    onOpenThread: enterThread, members: memberList, pinned, searchResults: SEARCH_RESULTS, threads,
    searchQuery,
    ...memberActions,
  }

  const railProps = {
    servers: SERVERS, folders: MOCK_FOLDERS, setMobileZone, view, onHome: goHome, onServer: goServer,
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
      if (bp === "mobile") setMobileZone("messages")
    },
    onOpenSettings: (section?: SettingsSection) => { if (section) setSettingsSection(section); setView("settings") },
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
  const contentColumn = ({ compact }: { compact?: boolean } = {}) => {

    if (openThread)
      return (
        <>
          <ChannelHeader
            channel={activeChannel}
            forum={isForum}
            rightPanel={rightPanel}
            onToggle={togglePanel}
            onBack={compact ? () => setMobileZone("nav") : undefined}
            breadcrumb={{
              label: openThread.name,
              onNavigateBack: () => setOpenThreadId(null),
              onRename: (name) => { setThreads((p) => p.map((t) => t.id === openThreadId ? { ...t, name } : t)); setForumPosts((p) => { const next = { ...p }; for (const [ch, posts] of Object.entries(next)) next[ch] = posts.map((fp) => fp.id === openThreadId ? { ...fp, name } : fp); return next }) },
            }}
          />
          <main className="flex min-h-0 flex-1 flex-col">
            <MessageList
              channel={openThread.name}
              messages={threadMessages[openThread.id] ?? []}
              onOpenThread={() => {}}
              {...profileProps}
            />
            <Composer channel={openThread.name} context="thread" members={composerMembers} onSend={sendThreadMessage} />
          </main>
        </>
      )

    if (view === "dm")
      return dm ? (
        <>
          <DmHeader dm={dm} onBack={compact ? () => setMobileZone("nav") : undefined} />
          <main className="flex min-h-0 flex-1 flex-col">
            <MessageList
              channel={dm.name}
              messages={dmMessages[dm.id] ?? []}
              onOpenThread={() => {}}
              {...profileProps}
              hero={
                <>
                  <div className="relative mb-3 w-fit"><Avatar label={dm.avatar} size={64} /></div>
                  <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.</p>
                </>
              }
            />
            <Composer channel={dm.name} context="dm" members={[]} onSend={sendDmMessage} />
          </main>
        </>
      ) : (
        <FriendsPage friends={friendList} pending={pending} blocked={blocked} onBack={compact ? () => setMobileZone("nav") : undefined} {...friendActions} {...profileProps} />
      )

    // forum channel → post list (a forum is a feed of threads, not a chat).
    // Shares ChannelHeader with text channels; forum actions live in its `actions` slot.
    if (isForum)
      return (
        <>
          <ChannelHeader
            channel={activeChannel}
            forum
            rightPanel={rightPanel}
            onToggle={togglePanel}
            notifLevel={(channelNotif[activeChannel] as ChannelNotifLevel) ?? "Use Server Default"}
            onSetNotifLevel={(l) => setChannelNotif((p) => ({ ...p, [activeChannel]: l }))}
            onBack={compact ? () => setMobileZone("nav") : undefined}
            tools={{ threads: false, pinned: false }}
          />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ForumView
              posts={forumPosts[activeChannel] ?? []}
              tags={FORUM_TAGS}
              onOpenPost={enterThread}
              onCreatePost={createForumPost}
              canManageTags
            />
          </main>
        </>
      )

    return (
      <>
        <ChannelHeader
          channel={activeChannel}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          notifLevel={(channelNotif[activeChannel] as ChannelNotifLevel) ?? "Use Server Default"}
          onSetNotifLevel={(l) => setChannelNotif((p) => ({ ...p, [activeChannel]: l }))}
          onBack={compact ? () => setMobileZone("nav") : undefined}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList channel={activeChannel} messages={messages} pinnedIds={pinnedIds} newDividerBefore={NEW_DIVIDER_BEFORE} typingUsers={["Lindsay"]} onOpenThread={enterThread} {...messageActions} {...profileProps} />
          <Composer channel={activeChannel} context="channel" members={composerMembers} onSend={sendMessage} onCreateThread={() => setCreatingThread(true)} replyingTo={replyTo?.authorName} onCancelReply={() => setReplyTo(null)} />
        </main>
      </>
    )
  }

  // portaled dialogs — rendered in every layout branch
  const dialogs = (
    <>
      <NewThreadDialog channel={activeChannel} open={creatingThread} onClose={() => setCreatingThread(false)} onCreate={(name, firstMessage) => createThread(name, { firstMessage })} />
      <Dialog open={editingProfile} onOpenChange={(o) => { if (!o) setEditingProfile(false) }}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
          <UserSettings onClose={() => setEditingProfile(false)} userName="Preview User" aboutMe={myAboutMe} onSave={(data) => { if (data.aboutMe !== undefined) setMyAboutMe(data.aboutMe) }} onLogout={() => toast("Logged out")} />
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
            <UserBar user={{ name: "Gener", avatar: "G" }} {...profileProps} onEditProfile={() => setEditingProfile(true)} />
          </ResizablePanel>

          <ResizableHandle className="bg-transparent" />

          <ResizablePanel defaultSize="76%" className="flex min-w-0 flex-col border-t border-r border-border bg-sidebar">
            {contentColumn()}
          </ResizablePanel>
        </ResizablePanelGroup>
        {rightPanel && view === "server" && !openThread && (
          <CommunityPanelSheet
            open
            onOpenChange={(v) => { if (!v) setRightPanel(null) }}
            kind={rightPanel}
            {...panelProps}
            {...profileProps}
          />
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
      {mobileZone === "nav" && (
        <>
          <ServerRail {...railProps} bottomInset={60} />
          <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--d-rail)" }}>
            <div className="flex min-h-0 flex-1">
              {sidebar({ noHeader: false })}
            </div>
            <UserBar user={{ name: "Gener", avatar: "G" }} {...profileProps} onEditProfile={() => setEditingProfile(true)} />
          </div>
        </>
      )}

      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
          {contentColumn({ compact: true })}
        </div>
      )}

      {rightPanel && view === "server" && !openThread && (
        <CommunityPanelSheet
          open
          onOpenChange={(v) => { if (!v) setRightPanel(null) }}
          kind={rightPanel}
          {...panelProps}
          {...profileProps}
        />
      )}
      {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === "Gener"} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {dialogs}
    </Shell>
  )
}
