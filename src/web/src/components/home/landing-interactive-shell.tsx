"use client"

import { useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import { CommunityShellLayout } from "@/components/community/shell/community-shell-layout"
import { ServerRail } from "@/components/community/shell/server-rail"
import { UserBar } from "@/components/community/shell/user-bar"
import { InboxPopover, type InboxTab } from "@/components/community/shell/community-inbox-popover"
import { ChannelSidebarTreeOwner } from "@/components/community/channels/channel-sidebar-tree-owner"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { DmHeader } from "@/components/community/channels/dm-header"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/messages/message-list"
import { Composer } from "@/components/community/messages/composer"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "@/components/community/messages/conversation-footer-shell"
import { ProfileRunningBotsCardView } from "@/components/community/social/profile-running-bots-card"
import { ProfileCard } from "@/components/community/social/profile-card"
import type { OpenProfile, Profile } from "@/components/community/social/profile-types"
import { MemberList } from "@/components/community/members/member-list"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useBreakpoint } from "@/hooks/use-mobile"
import type { Msg, SendAttachment } from "@/lib/community/models/message"
import { applyMessageReaction } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import type { Marked, Mention, UnreadServer } from "@/lib/community/models/inbox"
import type { NotifLevel } from "@alook/shared"
import { DEMO_CHANNELS, DEMO_DMS, DEMO_MESSAGES, DEMO_PROFILES, DEMO_SERVERS, DEMO_UNREADS, DEMO_MENTIONS } from "./landing-interactive-shell-data"
import { LandingBotLog } from "./landing-bot-log"
import styles from "./landing-interactive-shell.module.css"

const WorkspaceHome = dynamic(() => import("./landing-workspace-home").then((module) => module.WorkspaceHome), {
  loading: () => <p role="status" className="p-6 text-sm text-muted-foreground">Loading Home…</p>,
})

export default function LandingInteractiveShell() {
  useEffect(() => {
    window.parent.postMessage({ type: "alook-demo-ready" }, window.location.origin)
  }, [])
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } }))
  const [registry] = useState(() => createCommunityDbRegistry(queryClient, null))
  const lifetimeRef = useRef({ generation: 0 })
  useEffect(() => {
    const lifetime = lifetimeRef.current
    const generation = ++lifetime.generation
    return () => queueMicrotask(() => {
      if (lifetime.generation === generation) void registry.cleanup().finally(() => queryClient.clear())
    })
  }, [registry, queryClient])
  return <QueryClientProvider client={queryClient}><CommunityDbProvider registry={registry}>
    <CommunityPreviewProfileOwner profiles={DEMO_PROFILES}><CommunityPreviewNavigation value={true}>
      <InteractiveShell />
    </CommunityPreviewNavigation></CommunityPreviewProfileOwner>
  </CommunityDbProvider></QueryClientProvider>
}

function profileData(id: string): Profile {
  const person = DEMO_PROFILES.get(id) ?? DEMO_PROFILES.get("demo-gus")!
  return { userId: person.id, name: person.name ?? "", avatar: person.avatar ?? undefined, discriminator: person.discriminator ?? undefined,
    presence: person.presence, about: person.aboutMe ?? undefined,
    identity: person.kind === "bot" ? { kind: "bot", ownerProfile: { id: person.ownerUserId ?? "demo-gus", handle: person.ownerHandle ?? "Gus#1813" }, ownedByViewer: false } : { kind: "human" } }
}
const members: Member[] = [...DEMO_PROFILES.values()].map((person) => ({ id: person.id, userId: person.id, name: person.name!, avatar: person.avatar!, avatarVersion: 0, discriminator: person.discriminator ?? "", status: person.presence ?? "online", sub: person.aboutMe ?? "", role: person.id === "demo-gus" ? "owner" : "member" }))

function InteractiveShell() {
  const breakpoint = useBreakpoint()
  const [serverId, setServerId] = useState("demo-studio")
  const [conversation, setConversation] = useState("demo-general")
  const [homePage, setHomePage] = useState<"friends" | "bots" | "machines" | "dm" | null>(null)
  const [surface, setSurface] = useState<"list" | "detail">("list")
  const [messages, setMessages] = useState<Record<string, Msg[]>>(DEMO_MESSAGES)
  const [unread, setUnread] = useState(DEMO_UNREADS)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [presentVersion, setPresentVersion] = useState(0)
  const [submitVersion, setSubmitVersion] = useState(0)
  const [reply, setReply] = useState<Msg | null>(null)
  const [profile, setProfile] = useState<{ id: string; x: number; y: number } | null>(null)
  const [extension, setExtension] = useState<"none" | "inbox" | "profile">("none")
  const [inboxTab, setInboxTab] = useState<InboxTab>("unreads")
  const [membersOpen, setMembersOpen] = useState(false)
  const [marked, setMarked] = useState<Marked[]>([])
  const [notification, setNotification] = useState<NotifLevel | "Use Server Default">("All Messages")
  const [thread, setThread] = useState<Msg | null>(null)
  const [threadMessages, setThreadMessages] = useState<Record<string, Msg[]>>({})
  const fileUrls = useRef<string[]>([])
  useEffect(() => () => { fileUrls.current.forEach((url) => URL.revokeObjectURL(url)) }, [])
  const direct = homePage === "dm"
  const server = DEMO_SERVERS.find((item) => item.id === serverId)!
  const categories = DEMO_CHANNELS[serverId]
  const channel = categories.flatMap((item) => item.channels).find((item) => item.id === conversation)
  const dm = DEMO_DMS.find((item) => item.id === conversation) ?? DEMO_DMS[0]
  const allRows = messages[conversation] ?? []
  const pending = unread[conversation] ?? 0
  const rows = allRows
  useEffect(() => {
    if (!scrollRoot || !pending) return
    const onScroll = () => {
      if (scrollRoot.clientHeight > 0 && scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight <= 2) {
        setUnread((current) => ({ ...current, [conversation]: 0 }))
      }
    }
    scrollRoot.addEventListener("scroll", onScroll, { passive: true })
    return () => scrollRoot.removeEventListener("scroll", onScroll)
  }, [conversation, pending, scrollRoot])
  const totalUnread = Object.values(unread).filter((count) => count > 0).length
  const openProfile: OpenProfile = (name, event, _discriminator, id) => {
    const person = id ?? [...DEMO_PROFILES.values()].find((item) => item.name === name)?.id
    if (person) { setExtension("none"); setProfile({ id: person, x: event.clientX, y: event.clientY }) }
  }
  const pickConversation = (id: string) => { setConversation(id); setSurface("detail"); setReply(null); setProfile(null); setMembersOpen(false); setThread(null) }
  const pickServer = (id: string) => { setServerId(id); setHomePage(null); pickConversation(DEMO_CHANNELS[id][0].channels[0].id); setSurface("list") }
  const pickDm = (id: string) => { setHomePage("dm"); pickConversation(id) }
  const messagePerson = (id: string) => pickDm(DEMO_DMS.find((item) => item.userId === id)?.id ?? `demo-dm-${id.slice(5)}`)
  const showHome = (page: "friends" | "bots" | "machines") => { setHomePage(page); setSurface("detail"); setProfile(null); setThread(null) }
  const catchUp = () => { setUnread((current) => ({ ...current, [conversation]: 0 })); setPresentVersion((value) => value + 1) }
  const send = (text: string, files?: SendAttachment[]) => {
    if (!text.trim() && !files?.length) return false
    const message: Msg = { id: crypto.randomUUID(), type: "chat", authorId: "demo-gus", content: text.trim(), createdAt: new Date().toISOString(), seq: allRows.length + 1,
      attachments: files?.map(({ file, width, height }) => { const url = URL.createObjectURL(file); fileUrls.current.push(url); return file.type.startsWith("image/") ? { kind: "image", name: file.name, url, contentType: file.type, sizeBytes: file.size, width, height } : { kind: "file", name: file.name, url, contentType: file.type, sizeBytes: file.size, size: `${Math.ceil(file.size / 1024)} KB` } }),
      ...(reply ? { replyTo: { id: reply.id, authorId: reply.authorId ?? "demo-alli", authorName: DEMO_PROFILES.get(reply.authorId ?? "")?.name ?? "", text: reply.content ?? "" } } : {}),
    }
    setMessages((current) => ({ ...current, [conversation]: [...(current[conversation] ?? []), message] })); setReply(null); catchUp(); setSubmitVersion((value) => value + 1)
    return true
  }
  const openUnread = (targetServer: string, id: string) => { setServerId(targetServer); setHomePage(null); pickConversation(id); setUnread((items) => ({ ...items, [id]: 0 })); setPresentVersion((value) => value + 1); setExtension("none") }
  const unreadMentions = (id: string) => unread[id] > 0 ? messages[id].slice(-unread[id]).filter((message) => DEMO_MENTIONS[id]?.includes(message.id)) : []
  const unreadServers: UnreadServer[] = DEMO_SERVERS.map((item) => ({ serverId: item.id, serverName: item.name,
    channels: DEMO_CHANNELS[item.id].flatMap((group) => group.channels).filter((item) => unread[item.id] > 0).map((item) => ({ channelId: item.id, channelName: item.name, type: "text" as const, lastMessageAt: messages[item.id].at(-1)!.createdAt!, lastUnreadSeq: messages[item.id].length, mentionCount: unreadMentions(item.id).length, hasDirectUnread: true, children: [] })) })).filter((item) => item.channels.length)
  const mentions: Mention[] = unreadServers.flatMap((item) => item.channels.flatMap((room) => unreadMentions(room.channelId).map((m) => ({ id: room.channelId, server: item.serverName, serverId: item.serverId, channel: room.channelName, channelId: room.channelId, m }))))
  const inbox = <InboxPopover surface="extension" unreads={unreadServers} unreadDms={[]} mentions={mentions} marked={marked} hasProjectedUnreads={totalUnread > 0} hasProjectedMentions={mentions.length > 0}
    activeTab={inboxTab} onActiveTabChange={setInboxTab} onOpenChannel={(item, room) => openUnread(item.serverId, room.channelId)} onOpenMention={(item) => openUnread(item.serverId!, item.channelId!)}
    onOpenMarked={(item) => openUnread(item.serverId ?? serverId, item.channelId)} onUnmark={(id) => setMarked((items) => items.filter((item) => item.m.id !== id))}
    onDeleteMention={(id) => setUnread((items) => ({ ...items, [id]: 0 }))} onMarkAllRead={() => { setUnread({}); setPresentVersion((value) => value + 1) }} />
  const runningBots = [...DEMO_PROFILES.values()].filter((person) => person.kind === "bot" && person.ownerUserId === "demo-gus").map((person) => ({ id: person.id, name: person.name!, image: person.avatar ?? null, activityEmoji: person.statusEmoji!, activityText: person.statusText! }))
  const profileCompanion = <ProfileRunningBotsCardView runningBots={runningBots} onOpenBotAudit={(id) => {
    const anchor = document.activeElement?.getBoundingClientRect()
    setExtension("none")
    setProfile({ id, x: anchor?.right ?? window.innerWidth / 2, y: anchor?.top ?? window.innerHeight / 2 })
  }} />
  const selfProfile = <ProfileCard extension data={profileData("demo-gus")} x={0} y={0} bp={breakpoint} onClose={() => setExtension("none")} />
  const sidebar = homePage ? <DmSidebar dms={DEMO_DMS} activeDm={direct ? conversation : null} onPickDm={pickDm} onShowFriends={() => showHome("friends")} onShowBots={() => showHome("bots")} onShowMachines={() => showHome("machines")} friendsActive={homePage === "friends"} botsActive={homePage === "bots"} machinesActive={homePage === "machines"} />
    : <ChannelSidebarTreeOwner key={serverId} scopeKey={`landing:${serverId}`} categories={categories.map((group) => ({ ...group, channels: group.channels.map((item) => ({ ...item, active: item.id === conversation, unread: (unread[item.id] ?? 0) > 0 })) }))} serverName={server.name} activeChannel={conversation} setActiveChannel={pickConversation} isAdmin={false} currentUserId="demo-gus" />
  const conversationView = <>
    {direct ? <DmHeader dm={dm} titleAs="div" onBack={() => setSurface("list")} /> : <ChannelHeader channel={channel?.name ?? "general"} rightPanel={membersOpen ? "members" : null} onToggle={() => setMembersOpen((open) => !open)} mobileBack={() => setSurface("list")} tools={{ threads: false, pinned: false }} notifLevel={notification} onSetNotifLevel={setNotification} />}
    <main data-slot="community-conversation-surface" className={`${styles.messageSurface} flex min-h-0 flex-1 flex-col`}>
      <ConversationFooterSlotProvider>
        <MessageList key={conversation} channel={direct ? dm.name : channel?.name ?? "general"} variant={direct ? "dm" : "channel"} messages={rows} typingUsers={conversation === "demo-general" ? ["Alli"] : []}
          hero={direct ? <><div className="relative mb-3 w-fit"><Avatar label={dm.avatar} seed={dm.userId} size={64} /></div><h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2><p className="mt-1 text-sm text-muted-foreground">This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.</p></> : undefined}
          newDividerBefore={DEMO_UNREADS[conversation] ? DEMO_MESSAGES[conversation].at(-DEMO_UNREADS[conversation])?.id : undefined} initialPositionMessageId={pending ? rows[0]?.id : undefined} historyStartKnown
          onScrollRoot={setScrollRoot} unreadCount={pending} onJumpToPresent={catchUp} presentVersion={presentVersion} localSubmitVersion={submitVersion} viewerUserId="demo-gus"
          onOpenProfile={openProfile} onOpenThread={(id) => setThread(allRows.find((row) => row.id === id) ?? null)} onCreateThread={(id) => setThread(allRows.find((row) => row.id === id) ?? null)}
          onReply={(id) => setReply(allRows.find((row) => row.id === id) ?? null)} resolveUserName={(id) => DEMO_PROFILES.get(id)?.name ?? "Member"}
          onToggleReaction={(id, emoji) => setMessages((current) => ({ ...current, [conversation]: current[conversation].map((row) => row.id === id ? { ...row, reactions: applyMessageReaction(row.reactions, emoji, "demo-gus", !row.reactions?.some((reaction) => reaction.emoji === emoji && reaction.me), "demo-gus") } : row) }))}
          onMark={(id) => { const row = allRows.find((row) => row.id === id); if (row) setMarked((items) => items.some((item) => item.m.id === id) ? items.filter((item) => item.m.id !== id) : [...items, { id, server: server.name, serverId, channel: channel?.name ?? dm.name, channelId: conversation, m: row }]) }} />
        <ConversationFooterShell><Composer key={conversation} channel={direct ? dm.name : channel?.name ?? "general"} context={direct ? "dm" : "channel"} members={members} sendContract="accepted" onAcceptSend={send} autoFocus={false}
          replyingTo={reply ? { authorId: reply.authorId, authorName: DEMO_PROFILES.get(reply.authorId ?? "")?.name ?? "", text: reply.content ?? "" } : undefined} onCancelReply={() => setReply(null)} /></ConversationFooterShell>
      </ConversationFooterSlotProvider>
    </main>
  </>
  return <CommunityShellLayout breakpoint={breakpoint} surface={surface} testId="landing-interactive-shell" label="Alook workspace"
    rail={<ServerRail servers={DEMO_SERVERS.map((item) => ({ ...item, active: !homePage && item.id === serverId, unread: unreadServers.some((room) => room.serverId === item.id) }))} folders={[]} view={homePage ? "dm" : "server"} activeServerId={homePage ? "" : serverId} onHome={() => { showHome("friends"); setSurface("list") }} onServerNavigate={pickServer} />}
    sidebar={sidebar} main={<div className="flex min-h-0 flex-1 flex-col bg-background">{homePage && homePage !== "dm" ? <WorkspaceHome page={homePage} onBack={() => setSurface("list")} onDm={messagePerson} onOpenProfile={openProfile} onMachines={() => showHome("machines")} /> : conversationView}</div>}
    userBar={<UserBar breakpoint={breakpoint} user={{ id: "demo-gus", name: "Gus", avatar: DEMO_PROFILES.get("demo-gus")!.avatar! }} inbox={inbox} hasUnread={totalUnread > 0} unreadCount={totalUnread}
      inboxOpen={extension === "inbox"} onInboxOpenChange={(open) => setExtension(open ? "inbox" : "none")} onOpenProfile={() => setExtension((current) => current === "profile" ? "none" : "profile")} onEditProfile={() => setExtension("profile")}
      extension={{ active: extension, inbox, profile: selfProfile, profileCompanion, update: null, updateBadgePhase: null, eligibleMachines: [], onOpenUpdate: () => {}, onRequestUpdate: () => {}, onDismiss: () => setExtension("none") }} />}
    overlays={<>
      {profile && <ProfileCard key={profile.id} data={profileData(profile.id)} secondaryCard={DEMO_PROFILES.get(profile.id)?.kind === "bot" ? <LandingBotLog key={profile.id} botId={profile.id} /> : undefined} x={profile.x} y={profile.y} bp={breakpoint} onClose={() => setProfile(null)} canMessage={profile.id !== "demo-gus"}
        onMessage={(id, text) => { messagePerson(id); if (text.trim()) setMessages((items) => { const target = DEMO_DMS.find((item) => item.userId === id)?.id ?? `demo-dm-${id.slice(5)}`; return { ...items, [target]: [...(items[target] ?? []), { id: crypto.randomUUID(), type: "chat", authorId: "demo-gus", content: text, createdAt: new Date().toISOString() }] } }); setProfile(null) }}
        onOpenOwnerProfile={(owner) => setProfile({ ...profile, id: owner.id })} />}
      <Sheet open={membersOpen} onOpenChange={setMembersOpen}><SheetContent><SheetHeader><SheetTitle>Members</SheetTitle></SheetHeader><MemberList members={members} onOpenProfile={openProfile} /></SheetContent></Sheet>
      <Sheet open={!!thread} onOpenChange={(open) => { if (!open) setThread(null) }}><SheetContent className="flex flex-col p-0"><SheetHeader className="p-4"><SheetTitle>Thread</SheetTitle></SheetHeader>{thread && <ConversationFooterSlotProvider><MessageList channel="Thread" messages={[thread, ...(threadMessages[thread.id] ?? [])]} onOpenThread={() => {}} onOpenProfile={openProfile} viewerUserId="demo-gus" /><ConversationFooterShell><Composer channel="Thread" context="channel" members={members} sendContract="accepted" autoFocus={false} onAcceptSend={(text) => { if (!text.trim()) return false; setThreadMessages((items) => ({ ...items, [thread.id]: [...(items[thread.id] ?? []), { id: crypto.randomUUID(), type: "chat", authorId: "demo-gus", content: text, createdAt: new Date().toISOString() }] })); return true }} /></ConversationFooterShell></ConversationFooterSlotProvider>}</SheetContent></Sheet>
    </>} />
}
