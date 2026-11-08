"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { ServerRail } from "@/components/community/shell/server-rail"
import { ChannelSidebarTreeOwner } from "@/components/community/channels/channel-sidebar-tree-owner"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { Message } from "@/components/community/messages/message"
import { TypingIndicator } from "@/components/community/messages/typing-indicator"
import { UserBar } from "@/components/community/shell/user-bar"
import { InboxPopover } from "@/components/community/shell/community-inbox-popover"
import { DEMO_CHANNELS, DEMO_MESSAGES, DEMO_PROFILES, DEMO_SERVERS } from "@/components/home/landing-interactive-shell-data"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { MemberList } from "@/components/community/members/member-list"
import { EmptyState } from "@/components/community/empty-state"
import { DateDivider, NewDivider } from "@/components/community/dividers"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import { MessageListSkeleton } from "@/components/community/messages/message-list-view"
import { Button } from "@/components/ui/button"
import { messageNotification } from "@/components/ui/toast"
import { applyMessageReaction, type Msg } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { Inbox } from "lucide-react"
import { BotFormFields } from "@/components/community/bots/bot-form-fields"
import { CreateChannelDialog } from "@/components/community/settings/create-channel-dialog"
import { MachineCard } from "@/components/community/machines/machine-card"
import type { MachineSummary } from "@/lib/community/machines"
import type { AvatarDraft } from "@/lib/avatar/model"
import { useAvatarDraftPreview } from "@/lib/avatar/use-avatar-draft-preview"
import { ForumView } from "@/components/community/channels/forum-view"
import type { ForumThread } from "@/lib/community/models/message"
import { renderBotMachineGroup } from "@/components/community/bots/bot-list-machine-group"
import type { BotListController, BotMachineGroup } from "@/components/community/bots/bot-list-types"
import { Composer } from "@/components/community/messages/composer"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "@/components/community/messages/conversation-footer-shell"
import s from "./brand-visual.module.css"

export function Fixtures({ children, accountId = null }: { children: ReactNode; accountId?: string | null }) {
  return <FixtureOwner key={JSON.stringify(accountId)} accountId={accountId}>{children}</FixtureOwner>
}

function FixtureOwner({ children, accountId }: { children: ReactNode; accountId: string | null }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }))
  const [registry] = useState(() => {
    const registry = createCommunityDbRegistry(queryClient, accountId)
    if (accountId) registry.runtime.ws.actions.activateProfileAccount(accountId)
    return registry
  })
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (disposeTimer.current !== null) clearTimeout(disposeTimer.current)
    return () => {
      disposeTimer.current = setTimeout(() => { void registry.cleanup().finally(() => queryClient.clear()) }, 0)
    }
  }, [registry, queryClient])
  return (
    <CommunityPreviewProfileOwner profiles={DEMO_PROFILES}>
      <QueryClientProvider client={queryClient}>
        <CommunityDbProvider registry={registry}>{children}</CommunityDbProvider>
      </QueryClientProvider>
    </CommunityPreviewProfileOwner>
  )
}

export function Specimen({ label, note, className, children }: { label: string; note?: string; className?: string; children: ReactNode }) {
  return (
    <figure className={`${s.specimen} ${className ?? ""}`}>
      <figcaption><b>{label}</b>{note ? <span>{note}</span> : null}</figcaption>
      <div className={s.specimenBody}>{children}</div>
    </figure>
  )
}

const MESSAGES = (DEMO_MESSAGES["demo-general"] ?? []).slice(0, 4)
const SEED_REACTIONS: Msg["reactions"] = [
  { emoji: "👍", count: 2, me: false, userIds: ["demo-shelly", "demo-tracy"] },
  { emoji: "🎨", count: 1, me: true, userIds: ["demo-gus"] },
]
const MEMBERS: Member[] = [...DEMO_PROFILES.values()].map((p) => ({
  id: p.id, userId: p.id, name: p.name!, avatar: p.avatar!, avatarVersion: 0, discriminator: p.discriminator ?? "",
  status: p.presence ?? "online", sub: p.aboutMe ?? "", role: p.id === "demo-gus" ? "owner" : "member",
}))
const MACHINES = [
  { id: "m-mac", displayName: "Gus's MacBook", hostname: "gus-mbp", platform: "darwin", arch: "arm64", daemonVersion: "0.9.4", status: "online", lastSeenAt: new Date().toISOString(), availableRuntimes: [{ id: "claude", version: "2.1.0", status: "healthy" }, { id: "codex", version: "0.42.0", status: "healthy" }] },
  { id: "m-box", displayName: "Studio box", hostname: "studio", platform: "linux", arch: "x64", daemonVersion: "0.9.1", status: "offline", lastSeenAt: new Date(Date.now() - 36e5 * 5).toISOString(), availableRuntimes: [] },
] as unknown as MachineSummary[]
const POSTS: ForumThread[] = [
  { title: "Homepage hero: which object leads?", author: "demo-gus", tags: ["design", "landing"], preview: "CD player or the beige Mac? I lean Mac with a sticker.", n: 6 },
  { title: "Phone flow notes from the first visit", author: "demo-shelly", tags: ["bug"], preview: "The profile sheet covers the composer on small phones.", n: 3 },
  { title: "Weekly release room recap", author: "demo-alli", tags: ["archived"], preview: "Shipped the inbox tabs and the frameless dialogs.", n: 2 },
].map((p, i) => {
  const who = DEMO_PROFILES.get(p.author)
  return {
    id: `post-${i}`, name: p.title, messageCount: p.n, lastMessageAt: new Date(Date.now() - i * 36e5).toISOString(),
    parent: { authorName: who?.name ?? "", text: p.preview }, authorId: p.author, authorAvatar: who?.avatar ?? "", authorAvatarVersion: 0,
    openerMessageId: `opener-${i}`, tags: p.tags, preview: p.preview,
    participants: [...DEMO_PROFILES.values()].slice(0, 3).map((x) => ({ id: x.id, name: x.name ?? "", avatar: x.avatar ?? "", avatarVersion: 0 })),
    participantCount: 3 + i,
  } as unknown as ForumThread
})
const noop = () => {}

function boardBotController(collapsed: Set<string>, setCollapsed: BotListController["setCollapsedMachines"]): BotListController {
  return {
    bringMachineOnline: noop, chatWithBot: noop, collapsedMachines: collapsed, groupRefs: { current: {} }, highlightId: null,
    machineName: () => "Gus's MacBook", openActivity: noop, openMemberships: noop, pendingActiveBotIds: new Set<string>(),
    profilesByUserId: new Map([...DEMO_PROFILES.values()].map((p) => [p.id, p])), setBotActive: async () => {}, setBugReportBot: noop,
    setBugReportOpen: noop, setCollapsedMachines: setCollapsed, setConfirmDelete: noop, setConfirmReset: noop, setConfirmResetMachine: noop,
    setEditOpen: noop, setEditingBot: noop,
  } as unknown as BotListController
}
const BOT_GROUP = {
  machineId: "m-mac",
  machine: null,
  bots: ["demo-alli", "demo-cecilia"].map((id) => {
    const p = DEMO_PROFILES.get(id)
    return { id, name: p?.name ?? id, image: p?.avatar ?? "", isActive: true, runtime: "claude", modelName: "claude-opus-5-5", usage: null }
  }),
} as unknown as BotMachineGroup
const TOASTS = [
  { type: "success", title: "Bot created", description: "Alli is ready on your Mac." },
  { type: "warning", title: "Machine update available", description: "Update to get more features." },
  { type: "error", title: "Couldn't send", description: "Check your connection and try again." },
] as const

export function AppComponents() {
  const [server, setServer] = useState(DEMO_SERVERS[0]?.id ?? "")
  const [channel, setChannel] = useState("demo-general")
  const [inboxOpen, setInboxOpen] = useState(false)
  const [reactions, setReactions] = useState(SEED_REACTIONS)
  const [retrying, setRetrying] = useState(false)
  const [botName, setBotName] = useState("Pixel")
  const [botDesc, setBotDesc] = useState("")
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "procedural", image: DEMO_PROFILES.get("demo-alli")?.avatar ?? "" })
  useAvatarDraftPreview(avatar)
  const [channelOpen, setChannelOpen] = useState(false)
  const [tag, setTag] = useState("All")
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(new Set())
  const [sent, setSent] = useState<Msg[]>([])
  // Relative times ("Active 1h ago") depend on the clock; render those specimens after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // The real bot form autofocuses its name; on this board, keep the page at the top.
  useEffect(() => {
    const el = document.activeElement
    if (el instanceof HTMLElement && el.id === "bot-name") { el.blur(); window.scrollTo(0, 0) }
  }, [])
  const react = (emoji: string) => setReactions((r) => applyMessageReaction(r, emoji, "demo-gus", !(r ?? []).some((x) => x.emoji === emoji && x.me), "demo-gus"))
  const messages = MESSAGES.map((m, i) => (i === 1 ? { ...m, reactions } : m))
  const categories = DEMO_CHANNELS[server] ?? DEMO_CHANNELS["demo-studio"] ?? []
  return (
    <Fixtures>
      <div className={s.appGrid}>
        <Specimen label="Server rail" note="Click a server" className={s.specRail}>
          <div className={s.railHost}>
            <ServerRail servers={DEMO_SERVERS} folders={[]} activeServerId={server} view="server" bottomInset={0} onHome={() => {}} onServer={() => {}} onServerNavigate={(id: string) => setServer(id)} />
          </div>
        </Specimen>
        <Specimen label="Channel tree" note="Hover and select" className={s.specTree}>
          <div className={s.treeHost}>
            <ChannelSidebarTreeOwner key={server} scopeKey={`brand:${server}`} categories={categories} serverName={DEMO_SERVERS.find((x) => x.id === server)?.name ?? ""} activeChannel={channel} setActiveChannel={setChannel} isAdmin={false} currentUserId="demo-gus" />
          </div>
        </Specimen>
        <Specimen label="Conversation" note="Header, messages, typing" className={s.specConvo}>
          <div className={s.convoHost}>
            <ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={() => {}} />
            <div className={s.convoList}>
              <DateDivider label="Oct 21, 2026" />
              {messages.slice(0, 2).map((m) => <Message key={m.id} m={m} onOpenThread={() => {}} onToggleReaction={react} onReact={react} onReply={() => {}} onCopy={() => {}} />)}
              <NewDivider />
              {messages.slice(2).map((m) => <Message key={m.id} m={m} onOpenThread={() => {}} onToggleReaction={react} onReact={react} onReply={() => {}} onCopy={() => {}} />)}
              {sent.map((m) => <Message key={m.id} m={{ ...m, grouped: false }} onOpenThread={() => {}} />)}
              <div className={s.typingSlot}><TypingIndicator names={["Alli"]} /></div>
            </div>
            <ConversationFooterSlotProvider>
              <ConversationFooterShell>
                <Composer channel="general" context="channel" members={MEMBERS} sendContract="accepted" autoFocus={false}
                  onAcceptSend={(text) => { if (!text.trim()) return false; setSent((xs) => [...xs, { id: `sent-${xs.length}`, type: "chat", authorId: "demo-gus", content: text, createdAt: new Date().toISOString() }]); return true }} />
              </ConversationFooterShell>
            </ConversationFooterSlotProvider>
          </div>
        </Specimen>
        <Specimen label="UserBar and Inbox" note="Open the inbox" className={s.specUser}>
          <div className={s.userHost}>
            {inboxOpen ? (
              <div className={s.inboxHost}>
                <InboxPopover unreads={[]} unreadDms={[]} mentions={[]} marked={[]} hasProjectedUnreads={false} hasProjectedMentions={false} />
              </div>
            ) : null}
            <UserBar
              breakpoint="desktop"
              user={{ id: "demo-gus", name: "Gus", avatar: LANDING_HUMAN_AVATARS.gus, runningBotCount: 2 }}
              onEditProfile={() => {}}
              inbox={<span />}
              hasUnread
              unreadCount={3}
              inboxOpen={inboxOpen}
              onInboxOpenChange={setInboxOpen}
            />
          </div>
        </Specimen>
        <Specimen label="Member list" note="Hover a row, open a profile" className={s.specMembers}>
          <div className={s.membersHost}><MemberList members={MEMBERS} onOpenProfile={() => {}} /></div>
        </Specimen>
        <Specimen label="States" note="Empty, loading, error" className={s.specStates}>
          <div className={s.statesHost}>
            <div className={s.stateCell}><EmptyState icon={Inbox} label="Nothing here yet. Mentions and marked messages land here." /></div>
            <div className={s.stateCell}><MessageListSkeleton /></div>
            <div className={s.stateCell}>
              <ConversationResolutionErrorFrame as="div" retrying={retrying} onRetry={() => { setRetrying(true); setTimeout(() => setRetrying(false), 1200) }} />
            </div>
          </div>
        </Specimen>
        <Specimen label="Toast" note="Press to fire a real toast" className={s.specToast}>
          <div className={s.toastHost}>
            {TOASTS.map((t) => (
              <Button key={t.type} variant="outline" onClick={() => messageNotification.add({ type: t.type, title: t.title, description: t.description, timeout: 5000 })}>{t.title}</Button>
            ))}
          </div>
        </Specimen>
        <Specimen label="Forum" note="Filter by tag, hover a post" className={s.specForum}>
          <div className={s.forumHost}>
            {mounted ? <ForumView forumChannelId="brand-forum" members={MEMBERS} posts={tag === "All" ? POSTS : POSTS.filter((p) => p.tags.includes(tag))} tag={tag} onTagChange={setTag} availableTags={["design", "landing", "bug", "archived"]} tagsKnown onOpenPost={() => {}} /> : null}
          </div>
        </Specimen>
        <Specimen label="Frameless edit form" note="Bot form keeps its open layout" className={s.specForm}>
          <div className={s.formHost}>
            <BotFormFields avatarDraft={avatar} onAvatarChange={setAvatar} name={botName} setName={setBotName} onShuffle={() => setBotName(["Pixel", "Mochi", "Relay", "Juniper"][Math.floor(Math.random() * 4)]!)} description={botDesc} setDescription={setBotDesc} />
            <div className={s.formActions}><Button variant="ghost">Cancel</Button><Button>Create bot</Button></div>
          </div>
        </Specimen>
        <Specimen label="Bot list" note="Cassette cards; collapse the machine" className={s.specBots}>
          <div className={s.machinesHost}>
            {mounted ? renderBotMachineGroup(BOT_GROUP, boardBotController(collapsedMachines, setCollapsedMachines)) : null}
          </div>
        </Specimen>
        <Specimen label="Machines and dialogs" note="Online, offline, create channel" className={s.specMachines}>
          <div className={s.machinesHost}>
            {mounted && MACHINES.map((m) => <MachineCard key={m.id} machine={m} onDelete={() => {}} onReconnect={() => {}} />)}
            <Button variant="outline" onClick={() => setChannelOpen(true)}>Open Create channel</Button>
            {channelOpen ? <CreateChannelDialog category="Product" onClose={() => setChannelOpen(false)} onCreate={() => {}} /> : null}
          </div>
        </Specimen>
      </div>
    </Fixtures>
  )
}

export function FeatureMessages() {
  const rows = (DEMO_MESSAGES["demo-general"] ?? []).slice(4, 6)
  return (
    <Fixtures>
      <div className={s.convoList}>
        {rows.map((m) => <Message key={m.id} m={m} onOpenThread={() => {}} />)}
      </div>
    </Fixtures>
  )
}
