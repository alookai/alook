"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BotCreationItem, BotCreationPayload, FriendApprovalPayload, NotifLevel } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { FriendsPage } from "@/components/community/social/friends-page"
import { InviteFriendRow } from "@/components/community/social/invite-dialog"
import { StatusEditor } from "@/components/community/social/status-editor"
import { CommunityInviteCard } from "@/components/community/social/community-invite-card"
import { BotApprovalCard } from "@/components/community/social/bot-approval-card"
import { BotCreationRequestCard } from "@/components/community/social/bot-creation-request-card"
import { BotMarkStickerView } from "@/components/community/social/bot-mark-sticker"
import { BotAuditPreview } from "@/components/community/social/bot-audit-preview"
import { AddMembersDialog, type AddableCandidate } from "@/components/community/members/add-members-dialog"
import { PeoplePickerBody, PeoplePickerHeader, PeoplePickerRowsSkeleton } from "@/components/community/people-picker"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"
import { DmHeader } from "@/components/community/channels/dm-header"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import type { AuditEvent } from "@/hooks/community/use-bot-audit-log"
import type { Marked } from "@/lib/community/models/inbox"
import type { BlockedUser, Friend, PendingRequest } from "@/lib/community/models/people"
import { communityKeys } from "@/lib/query-keys"
import { DEMO_DMS, DEMO_PROFILES } from "@/components/home/landing-interactive-shell-data"
import { Fixtures, Specimen } from "./app-components"

/* ---------- demo fixtures ---------- */

const DAY = 864e5
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 6e4).toISOString()
/** Board-only cache seeds never go stale, so no query ever hits the network. */
const FRESH = { updatedAt: Date.now() + 365 * DAY }

/** Demo bot profiles carry no discriminator; the DM fixtures do. */
const DISCRIMINATORS = new Map(DEMO_DMS.filter((d) => d.discriminator).map((d) => [d.userId, d.discriminator]))
const profile = (id: string) => {
  const p = DEMO_PROFILES.get(id)!
  return p.discriminator || !DISCRIMINATORS.has(id) ? p : { ...p, discriminator: DISCRIMINATORS.get(id) }
}
const identity = (id: string) => {
  const p = profile(id)
  return { id, name: p.name ?? id, discriminator: p.discriminator ?? "0000", avatarVersion: 0, image: p.avatar ?? null }
}

const FRIENDS: Friend[] = ["demo-shelly", "demo-tracy", "demo-alli", "demo-cecilia", "demo-maya"].map((id, i) => {
  const p = profile(id)
  return {
    id: `fr-${id}`, userId: id, name: p.name ?? id, discriminator: p.discriminator ?? "", avatar: p.avatar ?? "", avatarVersion: 0,
    status: i === 1 ? "offline" : i === 4 ? "idle" : "online", sub: p.aboutMe ?? "",
    statusEmoji: p.statusEmoji ?? (i === 0 ? "☕" : null), statusText: p.statusText ?? (i === 0 ? "Mapping coffee spots" : null),
  } as Friend
})
const PENDING: PendingRequest[] = [
  { id: "req-evan", userId: "demo-evan", name: "Evan", avatar: profile("demo-evan").avatar ?? "", avatarVersion: 0, kind: "incoming", needsOwnerApproval: null },
  { id: "req-devin", userId: "demo-devin", name: "Devin", avatar: profile("demo-devin").avatar ?? "", avatarVersion: 0, kind: "incoming", needsOwnerApproval: null },
  { id: "req-claudette", userId: "demo-claudette", name: "Claudette", avatar: profile("demo-claudette").avatar ?? "", avatarVersion: 0, kind: "outgoing", needsOwnerApproval: "demo-gus" },
  { id: "req-maya", userId: "demo-maya", name: "Maya", avatar: profile("demo-maya").avatar ?? "", avatarVersion: 0, kind: "outgoing", needsOwnerApproval: null },
]
const BLOCKED: BlockedUser[] = [{ id: "blk-1", userId: "demo-blocked", name: "Spam Bot", avatar: "avatar:beam:Spam", avatarVersion: 0 }]

const INVITE_FRIENDS = FRIENDS.slice(0, 3)
const CANDIDATES: AddableCandidate[] = ["demo-shelly", "demo-tracy", "demo-maya", "demo-evan", "demo-devin"].map((id) => ({ userId: id, name: profile(id).name ?? null, avatar: profile(id).avatar ?? "" }))

const approval = (status: FriendApprovalPayload["status"], waitingOn: FriendApprovalPayload["waitingOn"], waitingOnId?: string): FriendApprovalPayload => ({
  friendshipId: `fa-${status}-${waitingOn ?? "none"}`, status, waitingOn,
  otherProfile: identity("demo-shelly"), botProfile: identity("demo-alli"),
  waitingOnProfile: waitingOnId ? identity(waitingOnId) : null,
})
const APPROVALS: { label: string; payload: FriendApprovalPayload }[] = [
  { label: "Pending, waiting on you", payload: approval("pending", "you") },
  { label: "Waiting on the other owner", payload: approval("pending", "other-owner", "demo-shelly") },
  { label: "Approved", payload: approval("approved", null) },
  { label: "Withdrawn", payload: approval("cancelled", null) },
]

const proposal = (itemId: string, name: string, backendId: string, model: string | null, effort: string | null, reason: string, createdId?: string): BotCreationItem => ({
  itemId, name, description: "", machineId: "m-mac", machineName: "Gus's MacBook", backendId, model, reasoningEffort: effort, reason,
  createdBot: createdId ? identity(createdId) : null,
} as BotCreationItem)
const creation = (requestId: string, status: BotCreationPayload["status"], bots: BotCreationItem[]): BotCreationPayload => ({
  requestId, status, requesterId: "demo-alli", ownerUserId: "demo-gus", createdAt: iso(30), resolvedAt: status === "pending" ? null : iso(5), bots,
})
const REQ_SINGLE = creation("bcr-1", "pending", [
  proposal("i-1", "Pixel", "claude", "claude-opus-5-5", "high", "Pixel will own the brand board: check each specimen in light and dark mode and post the visual problems to #design-review."),
])
const REQ_MULTI = creation("bcr-2", "pending", [
  proposal("i-2", "Relay", "codex", "gpt-5.5-codex", "medium", "Relay runs the release checklist and posts a short status to #release-room after every deploy."),
  proposal("i-3", "Juniper", "claude", "claude-sonnet-5", null, "Juniper reads new forum posts in #ideas and tags them so the owner can triage the queue in one pass."),
  proposal("i-4", "Mochi", "claude", null, null, "Mochi keeps the coffee map data clean."),
])
const REQ_APPROVED = creation("bcr-3", "approved", [proposal("i-5", "Cecilia", "claude", "claude-opus-5-5", "max", "Cecilia builds and debugs the web app.", "demo-cecilia")])
const REQ_DECLINED = creation("bcr-4", "declined", [proposal("i-6", "Spammy", "codex", null, null, "Posts hourly updates in every channel.")])

const AUDIT_BOT = "demo-alli"
const AUDIT: AuditEvent[] = ([
  ["wake_trigger", { channel: "/Studio#4012/design-review", seq: 412, senderHandle: "@gus#1813", reason: "mention" }, 42],
  ["cli_invocation", { subcommand: "inboxPull" }, 41],
  ["tool_call", { name: "Read", target: "src/web/src/app/brand-visual/app-people.tsx" }, 40],
  ["tool_call", { name: "Bash", target: "npx tsc --noEmit -p ." }, 38],
  ["text", { text: "The friends page reads well. The New badge needs more room next to the tab label." }, 36],
  ["cli_invocation", { subcommand: "messageSend" }, 35],
] as const).map(([kind, payload, minutesAgo], i) => ({ id: `pa-${String(i).padStart(2, "0")}`, kind, payload, sessionId: "s-1", launchId: "l-1", createdAt: iso(minutesAgo) }) as AuditEvent)
const THOUGHTS: AuditEvent[] = [
  "Gus wants the **People** section on the board. Start with the friends page and the DM sidebar.",
  "The sidebar selection slides between shortcuts. Check it in dark mode too.",
  "Approval cards: four states. The chip text is small; check contrast on the card surface.",
  "Posted the review to #design-review with screenshots attached.",
].map((text, i) => ({ id: `th-${i}`, kind: "text", payload: { text, truncated: false, chars: text.length }, sessionId: "s-1", launchId: "l-1", createdAt: iso(50 - i * 12) }) as AuditEvent)
const markMsg = (id: string, author: string, content: string, minutesAgo: number) => ({
  id, type: "chat", authorId: author, authorName: profile(author).name, authorAvatar: profile(author).avatar ?? "", content, createdAt: iso(minutesAgo),
}) as Marked["m"]
const MARKS: Marked[] = [
  { id: "mk-1", server: "Alook", serverId: "demo-studio", channel: "design-review", channelId: "demo-design-review", m: markMsg("mm-1", "demo-gus", "Can you put the real people UI on the board?", 60) },
  { id: "mk-2", server: "", serverId: null, channel: "Gus", channelId: "demo-dm-gus", m: markMsg("mm-2", "demo-gus", "Also check the invite card in dark mode.", 30) },
  { id: "mk-3", server: "Alook", serverId: "demo-studio", channel: "web-bugs", channelId: "demo-web-bugs", m: markMsg("mm-3", "demo-shelly", "Profile sheet covers the composer on small phones.", 12) },
  { id: "mk-4", server: "Alook", serverId: "demo-studio", channel: "release-room", channelId: "demo-release-room", m: markMsg("mm-4", "demo-cecilia", "Release notes draft is ready.", 5) },
]
const DMS = DEMO_DMS.map((d, i) => ({ ...d, preview: ["On it", "Pushed the fix", "Two edge cases left", "", "", "See you Sunday", "Lunch?", ""][i] ?? "", unread: i === 1 || i === 5 }))

function seedPeopleCache(client: QueryClient) {
  client.setQueryData(communityKeys.servers(), [], FRESH)
  client.setQueryData(communityKeys.inviteInfo("brand-invite"), { serverId: "demo-projects", serverName: "Side Projects", serverIcon: null, memberCount: 12 }, FRESH)
  client.setQueryData(communityKeys.inviteInfo("brand-invite-one"), { serverId: "demo-home", serverName: "Home", serverIcon: null, memberCount: 1 }, FRESH)
  client.setQueryData(communityKeys.botAuditLog(AUDIT_BOT), { pages: [{ events: [...AUDIT].reverse(), nextCursor: null }], pageParams: [null] }, FRESH)
}

/* ---------- layout ---------- */

const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, alignItems: "start" }
const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }
const pad: CSSProperties = { padding: 16, minWidth: 0 }
/** The notebook fills its parent's height at >=640px, like the profile card slot. */
const stickerHost: CSSProperties = { height: 452 }
const caption: CSSProperties = { fontSize: 11, color: "var(--muted-foreground)" }

/** Inner breathing room: the board's specimen body clips at its rounded edge. */
function Pad({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...pad, ...style }}>{children}</div>
}

function Seeded({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const [ready, setReady] = useState(false)
  useEffect(() => { seedPeopleCache(client); setReady(true) }, [client])
  return ready ? <>{children}</> : null
}

/* ---------- specimens ---------- */

function FriendsSpecimens() {
  const [tab, setTab] = useState<"all" | "new">("all")
  const [friends, setFriends] = useState(FRIENDS)
  const [pending, setPending] = useState(PENDING)
  const [blocked, setBlocked] = useState(BLOCKED)
  const settle = (id: string, accept: boolean) => new Promise<void>((resolve) => setTimeout(() => {
    const req = pending.find((p) => p.id === id)
    setPending((xs) => xs.filter((p) => p.id !== id))
    if (accept && req) setFriends((xs) => [...xs, { id: `fr-${req.userId}`, userId: req.userId, name: req.name, avatar: req.avatar, avatarVersion: 0, discriminator: profile(req.userId).discriminator ?? "", status: "online", sub: "" } as Friend])
    resolve()
  }, 600))
  return (
    <>
      <Specimen label="Friends page" note="All / New tabs; accept or reject a request">
        <div style={{ ...pad, padding: 0, display: "flex", flexDirection: "column", height: 520 }}>
          <FriendsPage friends={friends} pending={pending} blocked={blocked} activeTab={tab} onActiveTabChange={setTab}
            onAccept={(id) => settle(id, true)} onReject={(id) => settle(id, false)}
            onCancelRequest={({ id }) => setPending((xs) => xs.filter((p) => p.id !== id))}
            onUnblock={(id) => setBlocked((xs) => xs.filter((b) => (b.userId ?? b.id) !== id))}
            onRemoveFriend={(id) => setFriends((xs) => xs.filter((f) => f.id !== id))}
            onBlock={() => {}} onDm={() => {}} onOpenProfile={() => {}} onSendRequest={() => {}} />
        </div>
      </Specimen>
      <Specimen label="Friends page, empty" note="No friends, no requests">
        <div style={{ display: "flex", flexDirection: "column", height: 420 }}>
          <FriendsPage friends={[]} pending={[]} blocked={[]} />
        </div>
      </Specimen>
      <Specimen label="Friends page, loading" note="Skeleton">
        <div style={{ display: "flex", flexDirection: "column", height: 420 }}>
          <FriendsPage friends={[]} pending={[]} blocked={[]} loading />
        </div>
      </Specimen>
    </>
  )
}

type Shortcut = "friends" | "machines" | "bots" | "privacy" | null
function DmSpecimens() {
  const [shortcut, setShortcut] = useState<Shortcut>("friends")
  const [activeDm, setActiveDm] = useState<string | null>(null)
  const [notif, setNotif] = useState<NotifLevel>("All Messages")
  const pick = (next: Exclude<Shortcut, null>) => () => { setShortcut(next); setActiveDm(null) }
  const dm = DMS.find((d) => d.id === activeDm) ?? DMS[0]!
  return (
    <>
      <Specimen label="DM sidebar" note="Click Friends, Machines, My Bots, Privacy, or a DM">
        <CommunityPreviewNavigation value={true}>
          <div style={{ display: "flex", height: 520, background: "var(--sidebar)" }}>
            <DmSidebar dms={DMS} activeDm={activeDm} blockedUserIds={new Set(["demo-tracy"])} friendRequestCount={2}
              onPickDm={(id) => { setActiveDm(id); setShortcut(null) }}
              onShowFriends={pick("friends")} onShowMachines={pick("machines")} onShowBots={pick("bots")} onShowPrivacy={pick("privacy")}
              friendsActive={shortcut === "friends"} machinesActive={shortcut === "machines"} botsActive={shortcut === "bots"} privacyActive={shortcut === "privacy"} />
          </div>
        </CommunityPreviewNavigation>
      </Specimen>
      <Specimen label="DM header" note="Follows the selected DM; bell opens notification levels">
        <div style={stack}>
          <DmHeader dm={dm} notifLevel={notif} onSetNotifLevel={setNotif} />
          <DmHeader dm={DMS.find((d) => d.userId === "demo-shelly") ?? dm} titleAs="div" notifLevel="Nothing" onRetryIdentity={() => {}} />
          <DmHeader dm={dm} titleAs="div" titleState="pending" />
        </div>
      </Specimen>
    </>
  )
}

function StatusSpecimen() {
  const [status, setStatus] = useState<{ emoji: string | null; text: string | null }>({ emoji: "🎧", text: "Vibing" })
  return (
    <Specimen label="Status editor" note="Popover with presets and custom text"><Pad>
      <div style={stack}>
        <StatusEditor emoji={status.emoji} text={status.text} onChange={(emoji, text) => setStatus({ emoji, text })}>
          <Button variant="outline">{status.emoji || status.text ? `${status.emoji ?? ""} ${status.text ?? ""}` : "Set a status"}</Button>
        </StatusEditor>
        <span style={caption}>Current: {status.emoji ?? "-"} {status.text ?? "(none)"}</span>
      </div>
    </Pad></Specimen>
  )
}

function InviteSpecimens() {
  const [invited, setInvited] = useState<Set<string>>(new Set(["demo-tracy"]))
  const [inviting, setInviting] = useState<Set<string>>(new Set())
  const invite = (f: Friend) => {
    const id = f.userId!
    setInviting((s) => new Set(s).add(id))
    setTimeout(() => { setInviting((s) => { const n = new Set(s); n.delete(id); return n }); setInvited((s) => new Set(s).add(id)) }, 900)
  }
  return (
    <>
      <Specimen label="Server invite card" note="Recipient, sender, single member"><Pad>
        <div style={stack}>
          <CommunityInviteCard token="brand-invite" perspective="recipient" />
          <CommunityInviteCard token="brand-invite" perspective="sender" />
          <CommunityInviteCard token="brand-invite-one" perspective="neutral" />
        </div>
      </Pad></Specimen>
      <Specimen label="Invite dialog rows" note="Invite, sending, invited (full dialog skipped: needs live invite token)"><Pad>
        <div style={{ ...stack, gap: 0, background: "var(--popover)", borderRadius: "var(--radius)" }}>
          <PeoplePickerHeader title="Invite friends to Side Projects" />
          <div style={{ padding: 8 }}>
            {INVITE_FRIENDS.map((f) => (
              <InviteFriendRow key={f.id} friend={f} tokenReady inviting={inviting.has(f.userId!)} invited={invited.has(f.userId!)} onInvite={invite} />
            ))}
          </div>
        </div>
      </Pad></Specimen>
    </>
  )
}

function PickerSpecimens() {
  const [open, setOpen] = useState<null | "server" | "channel" | "empty">(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const candidates = CANDIDATES.filter((c) => !added.has(c.userId))
  const ready = { resolved: true, loading: false, error: false, retrying: false, retry: () => {} }
  const onAdd = (userId: string) => new Promise<void>((resolve) => setTimeout(() => { setAdded((s) => new Set(s).add(userId)); resolve() }, 800))
  return (
    <>
      <Specimen label="Add members dialog" note="Server, channel (same shared dialog), empty"><Pad>
        <div style={row}>
          <Button onClick={() => setOpen("server")}>Add members</Button>
          <Button variant="outline" onClick={() => setOpen("channel")}>Add to /design-review</Button>
          <Button variant="outline" onClick={() => setOpen("empty")}>Empty</Button>
          {added.size ? <Button variant="ghost" size="sm" onClick={() => setAdded(new Set())}>Reset</Button> : null}
        </div>
      </Pad></Specimen>
      <Specimen label="People picker states" note="Loading, error, empty, no matches"><Pad>
        <div style={stack}>
          <PeoplePickerBody state="loading" loading={<PeoplePickerRowsSkeleton secondaryLine actionClassName="w-16" />} errorMessage="" emptyMessage="" retrying={false} onRetry={() => {}} />
          <PeoplePickerBody state="error" loading={null} errorMessage="Couldn't load friends." emptyMessage="" retrying={false} onRetry={() => {}} />
          <PeoplePickerBody state="empty" loading={null} errorMessage="" emptyMessage="No friends to invite — everyone you know is already here." retrying={false} onRetry={() => {}} />
          <PeoplePickerBody state="search-empty" loading={null} errorMessage="" emptyMessage="" retrying={false} onRetry={() => {}} />
        </div>
      </Pad></Specimen>
      {open === "server" ? (
        <AddMembersDialog scopeId="brand-server" title="Add members to Alook" subtitle="Pick friends to add to this server." candidates={candidates} queryState={ready} onAdd={onAdd} onClose={() => setOpen(null)} />
      ) : open === "channel" ? (
        <AddMembersDialog scopeId="brand-channel" title="Add members to /design-review" subtitle="Added members can see and post in this channel." candidates={candidates} queryState={ready} onAdd={onAdd} onClose={() => setOpen(null)} />
      ) : open === "empty" ? (
        <AddMembersDialog scopeId="brand-empty" title="Add members to /release-room" subtitle="Added members can see and post in this channel." candidates={[]} queryState={ready} onAdd={onAdd} onClose={() => setOpen(null)} />
      ) : null}
    </>
  )
}

function BotCardSpecimens() {
  return (
    <>
      <Specimen label="Bot friend approval" note="Pending, waiting, approved, withdrawn"><Pad>
        <div style={stack}>
          {APPROVALS.map((a) => (
            <div key={a.label} style={{ ...stack, gap: 4 }}>
              <span style={caption}>{a.label}</span>
              <BotApprovalCard approval={a.payload} />
            </div>
          ))}
        </div>
      </Pad></Specimen>
      <Specimen label="Bot creation request" note="Owner view, one bot"><Pad>
        <BotCreationRequestCard request={REQ_SINGLE} messageId="msg-bcr-1" viewerUserId="demo-gus" onOpenProfile={() => {}} />
      </Pad></Specimen>
      <Specimen label="Bot creation request, three bots" note="Scroll sideways; requester view waits"><Pad>
        <div style={stack}>
          <BotCreationRequestCard request={REQ_MULTI} messageId="msg-bcr-2" viewerUserId="demo-gus" />
          <BotCreationRequestCard request={REQ_SINGLE} messageId="msg-bcr-1b" viewerUserId="demo-alli" />
        </div>
      </Pad></Specimen>
      <Specimen label="Bot creation request, resolved" note="PASS and NOT PASS stamps"><Pad>
        <div style={{ ...row, alignItems: "start", gap: 16 }}>
          <BotCreationRequestCard request={REQ_APPROVED} messageId="msg-bcr-3" viewerUserId="demo-gus" onOpenProfile={() => {}} />
          <BotCreationRequestCard request={REQ_DECLINED} messageId="msg-bcr-4" viewerUserId="demo-gus" />
        </div>
      </Pad></Specimen>
    </>
  )
}

function BotLogSpecimens() {
  const [stopPending, setStopPending] = useState(false)
  return (
    <>
      <Specimen label="Bot log sticker" note="Thoughts and Marks tabs"><Pad style={stickerHost}>
        <BotMarkStickerView active showStop stopPending={stopPending} onStop={() => { setStopPending(true); setTimeout(() => setStopPending(false), 1500) }}
          onOpenActivity={() => {}} activity={{ events: THOUGHTS, isLoading: false, isError: false, isNotFound: false }} marks={MARKS} isLoading={false} isError={false} />
      </Pad></Specimen>
      <Specimen label="Bot log sticker, empty" note="At rest, nothing marked"><Pad style={stickerHost}>
        <BotMarkStickerView active={false} showStop={false} stopPending={false} onStop={() => {}}
          activity={{ events: [], isLoading: false, isError: false, isNotFound: false }} marks={[]} isLoading={false} isError={false} />
      </Pad></Specimen>
      <Specimen label="Bot audit preview" note="Running and at rest"><Pad>
        <div style={stack}>
          <BotAuditPreview botId={AUDIT_BOT} active onOpen={() => {}} />
          <BotAuditPreview botId={AUDIT_BOT} active={false} onOpen={() => {}} />
        </div>
      </Pad></Specimen>
    </>
  )
}

/** /brand-visual: People specimens (real components on demo fixtures). */
export function AppPeopleSpecimens(_props: { mode: "light" | "dark" }) {
  // Relative times and the running clock depend on Date.now(); render after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return (
    <Fixtures>
      <Seeded>
        <div style={grid}>
          <FriendsSpecimens />
          <DmSpecimens />
          <StatusSpecimen />
          <InviteSpecimens />
          <PickerSpecimens />
          <BotCardSpecimens />
          <BotLogSpecimens />
        </div>
      </Seeded>
    </Fixtures>
  )
}
