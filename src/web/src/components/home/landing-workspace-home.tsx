"use client"

import { useState } from "react"
import { ChevronLeft, Plus } from "lucide-react"
import { FriendsPage } from "@/components/community/social/friends-page"
import { renderBotListView } from "@/components/community/bots/bot-list-view"
import type { BotListController, BotListOverlaySlots } from "@/components/community/bots/bot-list-types"
import { MachineCard } from "@/components/community/machines/machine-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { BotSummary } from "@/lib/community/bots"
import type { MachineSummary } from "@/lib/community/machines"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { DEMO_PROFILES } from "./landing-interactive-shell-data"

const MACHINE: MachineSummary = {
  id: "demo-mac", hostname: "gus-macbook", displayName: "Gus’s MacBook Pro", platform: "darwin", arch: "arm64", osRelease: "25.0", daemonVersion: "0.1.56",
  status: "online", lastSeenAt: "2026-10-21T05:00:00Z", createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-21T05:00:00Z", availableRuntimes: [{ id: "codex", status: "healthy", version: "0.116.0" }, { id: "claude", status: "healthy", version: "2.1.0" }],
}
const BOTS: BotSummary[] = ["alli", "cecilia", "claudette", "evan", "devin"].map((name, index) => {
  const profile = DEMO_PROFILES.get(`demo-${name}`)!
  return { id: profile.id, name: profile.name!, description: profile.aboutMe!, image: profile.avatar!, avatarVersion: 0, machineId: MACHINE.id, runtime: index === 1 ? "claude" : "codex", modelName: null, reasoningEffort: null, runtimeConfigRevision: 1, isActive: true }
})
const emptyOverlays = Object.fromEntries(["billing", "create", "help", "edit", "activity", "bug", "deleteDialog", "resetDialog", "resetMachineDialog"].map((key) => [key, <span key={key} />])) as BotListOverlaySlots

export function WorkspaceHome({ page, onBack, onDm, onOpenProfile, onMachines }: {
  page: "friends" | "bots" | "machines"
  onBack: () => void
  onDm: (userId: string) => void
  onOpenProfile: OpenProfile
  onMachines: () => void
}) {
  const [bots, setBots] = useState(BOTS)
  const [machines, setMachines] = useState([MACHINE])
  const [collapsedMachines, setCollapsedMachines] = useState(new Set<string>())
  const [groupRefs] = useState(() => ({ current: {} as Record<string, HTMLDivElement | null> }))
  const [panel, setPanel] = useState<string | null>(null)
  const [editingBot, setEditingBot] = useState<BotSummary | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [removedFriends, setRemovedFriends] = useState(new Set<string>())
  const [friendTab, setFriendTab] = useState<"all" | "new">("all")
  const edit = (bot: BotSummary | null) => { setEditingBot(bot); setName(bot?.name ?? ""); setDescription(bot?.description ?? "") }
  const friends = [...DEMO_PROFILES.values()].filter((profile) => profile.id !== "demo-gus" && !removedFriends.has(profile.id)).map((profile) => ({ id: profile.id, userId: profile.id, name: profile.name!, discriminator: profile.discriminator ?? "", avatar: profile.avatar!, avatarVersion: 0, status: profile.presence ?? "online" as const, sub: profile.kind === "bot" ? `Agent · ${profile.ownerHandle}` : profile.aboutMe ?? "" }))
  const openPanel = (title: string) => () => setPanel(title)
  const controller: BotListController = {
    bots, machines, profilesByUserId: DEMO_PROFILES, groups: machines.map((machine) => ({ machineId: machine.id, machine, bots: bots.filter((bot) => bot.machineId === machine.id) })),
    planSummary: { isFounder: true, plan: { id: "founder", displayName: "Founder" }, limit: 10, ownedCount: bots.length, activeCount: bots.filter((bot) => bot.isActive).length },
    collapsedMachines, setCollapsedMachines, groupRefs, highlightId: null,
    viewPlan: openPanel("Founder plan"), billingOpen: false, setBillingOpen: () => {}, canShowLimit: false, isCreateDisabled: false, pendingActiveBotIds: new Set(),
    setBotActive: async (bot, active) => { setBots((rows) => rows.map((row) => row.id === bot.id ? { ...row, isActive: active } : row)) },
    initialError: false, retryInitialLoad: () => {}, retryingInitialLoad: false, isLoading: false, machinesLoading: false, machinesUnknown: false,
    createOpen: false, setCreateOpen: () => {}, editingBot, setEditingBot: edit, editOpen: false, setEditOpen: () => setPanel("Edit bot"),
    activityBot: null, activityOpen: false, activityGeneration: 0, openActivity: (bot) => { edit(bot); setPanel("Activity") }, onActivityOpenChange: () => {}, onActivityOpenChangeComplete: () => {},
    bugReportBot: null, setBugReportBot: () => {}, bugReportOpen: false, setBugReportOpen: () => setPanel("Report a problem"),
    confirmDelete: null, setConfirmDelete: (bot) => { edit(bot); setPanel("Delete bot") }, confirmReset: null, setConfirmReset: (bot) => { edit(bot); setPanel("Reset session") },
    confirmResetMachine: null, setConfirmResetMachine: () => setPanel("Reset sessions"), helpOpen: false, setHelpOpen: () => setPanel("How your agent works"), guidedActive: false, guidedCreateLabel: "Create bot", guidedAvatarSeed: undefined,
    chatWithBot: async (bot) => onDm(bot.id), onBotCreated: async () => {}, openGuidedCreate: () => { edit(null); setPanel("Create bot") }, openMachines: onMachines,
    bringMachineOnline: () => setMachines((rows) => rows.map((row) => ({ ...row, status: "online" }))), machineName: () => MACHINE.displayName,
    deleteConfirmedBot: async () => {}, resetConfirmedBot: async () => {}, resetConfirmedMachine: async () => {},
  }
  const saveBot = () => {
    if (!name.trim()) return
    const id = editingBot?.id ?? `demo-bot-${crypto.randomUUID()}`
    const bot = { ...BOTS[0], ...editingBot, id, name: name.trim(), description }
    setBots((rows) => editingBot ? rows.map((row) => row.id === id ? bot : row) : [...rows, bot]); setPanel(null)
  }
  return <>
    {page === "friends" ? <FriendsPage friends={friends} pending={[]} blocked={[]} onBack={onBack} onOpenProfile={onOpenProfile} onDm={onDm}
      activeTab={friendTab} onActiveTabChange={setFriendTab} onRemoveFriend={(id) => setRemovedFriends((rows) => new Set([...rows, id]))}
      onBlock={(id) => setRemovedFriends((rows) => new Set([...rows, id]))} onSendRequest={({ userId }) => { setRemovedFriends((rows) => { const next = new Set(rows); next.delete(userId); return next }); setFriendTab("all") }} />
      : page === "bots" ? renderBotListView({ onBack }, controller, emptyOverlays)
      : <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6 sm:hidden"><Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back"><ChevronLeft className="size-5" /></Button><span className="text-base font-semibold">Machines</span></header>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 thin-scrollbar">
          <header className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 flex-col gap-1"><h1 className="text-xl font-medium">Machines</h1><p className="text-sm text-muted-foreground">Your computers running the alook daemon.</p></div><Button onClick={openPanel("Connect a machine")}><Plus className="size-4" />Connect machine</Button></header>
          <div className="flex flex-col gap-3">{machines.map((machine) => <MachineCard key={machine.id} machine={machine} onDelete={() => setMachines((rows) => rows.filter((row) => row.id !== machine.id))} onReconnect={() => setMachines((rows) => rows.map((row) => ({ ...row, status: "online" })))} />)}</div>
        </div>
      </div>}
    <Sheet open={panel !== null} onOpenChange={(open) => { if (!open) setPanel(null) }}>
      <SheetContent><SheetHeader><SheetTitle>{panel}</SheetTitle></SheetHeader>
        <div className="flex flex-col gap-4 p-6">
          {panel === "Create bot" || panel === "Edit bot" ? <><label className="flex flex-col gap-2 text-sm">Name<Input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="flex flex-col gap-2 text-sm">Description<Input value={description} onChange={(event) => setDescription(event.target.value)} /></label><p className="text-sm text-muted-foreground">Codex · {MACHINE.displayName}</p><Button onClick={saveBot}>Save</Button></>
          : panel === "Delete bot" ? <><p>Delete {editingBot?.name} from My Bots?</p><Button variant="destructive" onClick={() => { setBots((rows) => rows.filter((row) => row.id !== editingBot?.id)); setPanel(null) }}>Delete</Button></>
          : panel === "Activity" ? <><p className="text-sm text-muted-foreground">{editingBot?.name} · Today</p><p>Reviewed the shared design in Alook / design-review.</p><p>Answered Shelly’s question in Side Projects / coffee-map.</p><Button onClick={() => { if (editingBot) onDm(editingBot.id); setPanel(null) }}>Open conversation</Button></>
          : panel === "Connect a machine" ? <><p>Connect your computer to run agents with your local tools and projects.</p><Button onClick={() => { setMachines([MACHINE]); setPanel(null) }}>Connect MacBook Pro</Button></>
          : panel?.startsWith("Reset") ? <><p>The next message starts a fresh session. Your conversations stay in the room.</p><Button onClick={() => setPanel(null)}>Reset session</Button></>
          : <><p className="text-sm leading-relaxed">Your agents run on your computer. Invite them into a server so your friends can ask questions and work with them in the same conversation.</p><Button onClick={() => setPanel(null)}>Done</Button></>}
        </div>
      </SheetContent>
    </Sheet>
  </>
}
