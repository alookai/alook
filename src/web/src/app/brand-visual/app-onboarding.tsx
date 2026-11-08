"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BillingSummary, MachineCapacitySummary } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { advanceCommunityOnboarding, skipCommunityOnboarding, startCommunityOnboarding, useCommunityOnboarding } from "@/lib/community-onboarding"
import { communityKeys } from "@/lib/query-keys"
import type { MachineSummary } from "@/lib/community/machines"
import type { BillingController } from "@/hooks/community/use-billing"
import { DEMO_PROFILES } from "@/components/home/landing-interactive-shell-data"
import { CommunityOnboardingForm } from "@/components/community/onboarding/community-onboarding-form"
import { OnboardingSelectDialogPreview } from "@/components/community/onboarding/onboarding-select-dialog.preview"
import { OnboardingMachineDialog } from "@/components/community/onboarding/onboarding-machine-dialog"
import { OnboardingModelDialog } from "@/components/community/onboarding/onboarding-model-dialog"
import { OnboardingStatusDialog } from "@/components/community/onboarding/onboarding-status-dialog"
import type { OnboardingInitializationCheckpoint } from "@/components/community/onboarding/initialize-community-onboarding"
import { ConnectTile } from "@/components/community/onboarding-tiles/connect-tile"
import { CreateTile } from "@/components/community/onboarding-tiles/create-tile"
import { MemoryTile } from "@/components/community/onboarding-tiles/memory-tile"
import { NapTile } from "@/components/community/onboarding-tiles/nap-tile"
import { WorkspaceTile } from "@/components/community/onboarding-tiles/workspace-tile"
import { AgentHelpGallery } from "@/components/community/onboarding-tiles/agent-help-gallery"
import { MachineList, MachineListSkeleton, MachineUpdateDialog } from "@/components/community/machines/machine-list"
import { PairMachineSheet, PairMachineSteps, type PairMachineSheetMode } from "@/components/community/machines/pair-machine-sheet"
import { MachineCapacityUsage, MachineLimitDialog } from "@/components/community/machines/machine-capacity"
import { MachinePairMessageDiagram } from "@/components/community/machines/machine-pair-message-diagram"
import { UnresolvedMainSkeleton } from "@/components/community/shell/unresolved-main-skeleton"
import { CommunityConnectingIndicator } from "@/components/community/shell/community-connecting-indicator"
import { CommunityWsReconnectBoundary } from "@/components/community/shell/community-ws-reconnect-overlay"
import { BillingContent, BillingSheet } from "@/components/community/billing/billing-sheet"
import { FounderPlanChangeDialog } from "@/components/community/billing/founder-plan-change-dialog"
import { Fixtures, Specimen } from "./app-components"

const DAY = 864e5
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 6e4).toISOString()
/** Board-only cache seeds never go stale, so no query refetches on its own. */
const FRESH = { updatedAt: Date.now() + 365 * DAY }
const noop = () => {}

const OPENCODE_CATALOG = {
  catalogOrigin: "native_report" as const,
  updateMode: "live_next_turn" as const,
  defaultModelId: "anthropic/claude-opus-5-5",
  models: [
    { id: "anthropic/claude-opus-5-5", displayName: "Claude Opus 5.5", supportedReasoningEfforts: [] },
    { id: "openai/gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: [] },
    { id: "google/gemini-3-pro", displayName: "Gemini 3 Pro", supportedReasoningEfforts: [] },
  ],
}

const ONLINE_MAC = {
  id: "m-mac", displayName: "Gus's MacBook", hostname: "gus-mbp", platform: "darwin", arch: "arm64", osRelease: "23.6.0", daemonVersion: "0.9.4",
  createdAt: iso(60 * 24 * 40), updatedAt: iso(5), status: "online", lastSeenAt: iso(0),
  availableRuntimes: [
    { id: "claude", version: "2.1.0", status: "healthy" },
    { id: "opencode", version: "1.4.0", status: "healthy", reasoning: OPENCODE_CATALOG },
  ],
} as unknown as MachineSummary

const BROKEN_MAC = {
  ...ONLINE_MAC,
  availableRuntimes: [{ id: "claude", version: "2.0.9", status: "unhealthy", lastError: "claude: command not found (PATH=/usr/bin:/bin)" }],
} as unknown as MachineSummary

const FREE_CAPACITY: MachineCapacitySummary = { isFounder: false, plan: { id: "free", displayName: "Free" }, limit: 1, ownedCount: 0, onlineCount: 0 }
const HOUSE_CAPACITY: MachineCapacitySummary = { isFounder: false, plan: { id: "house", displayName: "House" }, limit: 3, ownedCount: 2, onlineCount: 2 }

function seedMachines(client: QueryClient, machines: MachineSummary[], capacity?: MachineCapacitySummary) {
  client.setQueryData(communityKeys.machines(), { machines, complete: true, observed: true, source: "network" }, FRESH)
  client.setQueryData([...communityKeys.machines(), "observations"], { quotas: [], ...(capacity ? { machineCapacity: capacity } : {}) }, FRESH)
  client.setQueryData(communityKeys.bots(), { bots: [], observed: true, source: "network" }, FRESH)
  client.setQueryData(["community", "latest-daemon-version"], { version: "0.9.4" }, FRESH)
}

const BOARD_USER = { id: "demo-gus", email: "gus@example.com", name: DEMO_PROFILES.get("demo-gus")?.name ?? "Gus", avatar: DEMO_PROFILES.get("demo-gus")?.avatar ?? "" }

const CHECKPOINT: OnboardingInitializationCheckpoint = {
  bots: [{ key: "lead", id: "demo-alli" }, { key: "doer", id: "demo-cecilia" }, { key: "reviewer", id: "demo-claudette" }],
  requestedServerName: "Gus-work-room",
}

const OFFERS: BillingSummary["offers"] = [
  { priceId: "price_house", botLimit: 5, machineLimit: 2, plan: { id: "house", displayName: "House" }, unitAmount: 1200, currency: "usd", interval: "month", intervalCount: 1 },
  { priceId: "price_studio", botLimit: 15, machineLimit: 5, plan: { id: "studio", displayName: "Studio" }, unitAmount: 3900, currency: "usd", interval: "month", intervalCount: 1 },
]
const FOUNDER: BillingSummary = { plan: { id: "studio", displayName: "Studio" }, isFounder: true, offers: OFFERS, subscription: null }
const SUBSCRIBED: BillingSummary = {
  plan: { id: "house", displayName: "House" }, isFounder: false, offers: OFFERS,
  subscription: {
    plan: { id: "house", displayName: "House" }, status: "active", currentPeriodEnd: new Date(Date.now() + 18 * DAY).toISOString(), cancelAt: null,
    scheduledChange: { plan: { id: "studio", displayName: "Studio" }, effectiveAt: new Date(Date.now() + 18 * DAY).toISOString() },
  },
}

function boardBilling(data: BillingSummary): BillingController {
  return {
    data, isPending: false, isFetching: false, isError: false, returnFrom: null, polling: false, actionError: null,
    isBusy: false, isCancelingChange: false, refresh: noop, portal: async () => {}, checkout: async () => {}, cancelChange: async () => {},
  } as unknown as BillingController
}

const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 16, alignItems: "start" }
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }
const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }
/** Fixed children (overlays, toasts) stay inside: translateZ makes this box their containing block. */
const contained = (height: number): CSSProperties => ({ position: "relative", height, overflow: "hidden", transform: "translateZ(0)", display: "flex", flexDirection: "column" })

function Pad({ children }: { children: ReactNode }) {
  return <div style={{ padding: 16, minWidth: 0 }}>{children}</div>
}

function Seeded({ machines, capacity, children }: { machines: MachineSummary[]; capacity?: MachineCapacitySummary; children: ReactNode }) {
  const client = useQueryClient()
  const [ready, setReady] = useState(false)
  useEffect(() => { seedMachines(client, machines, capacity); setReady(true) }, [client, machines, capacity])
  return ready ? <>{children}</> : null
}

/** One isolated runtime + cache per specimen, so onboarding state and seeds never leak between them. */
function Scope({ machines = [], capacity, children }: { machines?: MachineSummary[]; capacity?: MachineCapacitySummary; children: ReactNode }) {
  return (
    <Fixtures>
      <CurrentUserProvider initialUser={BOARD_USER}>
        <Seeded machines={machines} capacity={capacity}>{children}</Seeded>
      </CurrentUserProvider>
    </Fixtures>
  )
}

function TileSlot({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-70 overflow-hidden rounded-xl">
      <div className="aspect-200/130 w-full">{children}</div>
    </div>
  )
}

/** Stages that do not call the network on mount. Agent setup, manual pairing and
 * room initialization create real tokens, codes or bots, so the board closes the
 * real setup surface before it mounts those steps. */
const SAFE_STAGES = new Set(["harness", "model", "identity"])

function BoardOnboardingForm() {
  const runtime = useCommunityRuntime()
  const state = useCommunityOnboarding()
  const safe = state ? SAFE_STAGES.has(state.stage) : true
  useEffect(() => { if (!safe) skipCommunityOnboarding(runtime) }, [safe, runtime])
  return safe ? <CommunityOnboardingForm /> : null
}

function OnboardingShellLaunchers() {
  const runtime = useCommunityRuntime()
  const open = (stage: "harness" | "model" | "identity") => {
    skipCommunityOnboarding(runtime)
    startCommunityOnboarding(runtime)
    if (stage === "harness") return
    const harness = stage === "model" ? "opencode" : "claude"
    advanceCommunityOnboarding(runtime, "harness", "machine", { harness, setupMode: "manual" })
    advanceCommunityOnboarding(runtime, "machine", stage, { machineId: ONLINE_MAC.id, model: null })
  }
  return (
    <>
      <div style={row}>
        <Button onClick={() => open("harness")}>Harness</Button>
        <Button variant="outline" onClick={() => open("model")}>Model</Button>
        <Button variant="outline" onClick={() => open("identity")}>About you</Button>
      </div>
      <BoardOnboardingForm />
    </>
  )
}

function OnboardingPreviewLaunchers() {
  const [variant, setVariant] = useState<null | { key: number; online?: boolean; settingUp?: boolean }>(null)

  useEffect(() => {
    if (!variant) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setVariant(null) }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [variant])
  return (
    <>
      <div style={row}>
        <Button onClick={() => setVariant({ key: Date.now() })}>Walkthrough</Button>
        <Button variant="outline" onClick={() => setVariant({ key: Date.now(), online: true })}>Machine online</Button>
        <Button variant="outline" onClick={() => setVariant({ key: Date.now(), settingUp: true })}>Setting up</Button>
      </div>
      {variant ? <OnboardingSelectDialogPreview key={variant.key} simulateOnlineMachine={variant.online} showSettingUp={variant.settingUp} /> : null}
    </>
  )
}

function StatusDialogLaunchers() {
  const [status, setStatus] = useState<null | "loading" | "error" | "success">(null)
  return (
    <>
      <div style={row}>
        {(["loading", "error", "success"] as const).map((value) => (
          <Button key={value} size="sm" variant="outline" onClick={() => setStatus(value)}>{value[0]!.toUpperCase() + value.slice(1)}</Button>
        ))}
      </div>
      {status ? (
        <OnboardingStatusDialog
          status={status}
          currentStep={status === "loading" ? "inviting-bots" : status === "error" ? "creating-room" : "preparing-welcome"}
          checkpoint={CHECKPOINT}
          detail={status === "error" ? "We couldn’t finish setting up your room." : status === "success" ? "3 bots are in your room and ready to work." : "Follow along as your room comes together."}
          onRetry={noop}
          onContinue={() => setStatus(null)}
          onExit={() => setStatus(null)}
        />
      ) : null}
    </>
  )
}

function MachineDialogLaunchers() {
  const [dialog, setDialog] = useState<null | "command" | "connected">(null)
  const [model, setModel] = useState<string | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  return (
    <>
      <div style={row}>
        <Button size="sm" onClick={() => setDialog("command")}>Pair command</Button>
        <Button size="sm" variant="outline" onClick={() => setDialog("connected")}>Connected</Button>
        <Button size="sm" variant="outline" onClick={() => setModelOpen(true)}>Model</Button>
      </div>
      {dialog ? (
        <OnboardingMachineDialog
          open harness="claude" harnessLabel="Claude Code" totalSteps={3}
          {...(dialog === "connected"
            ? { previewConnectedMachine: { id: "m-mac", hostname: "gus-mbp" } }
            : { previewCommand: "npx --yes @alook/daemon@latest daemon start --machine-key mk_7F3C2A91" })}
          onConnected={noop} onChooseAnotherHarness={() => setDialog(null)} onManageMachines={() => setDialog(null)} onExit={() => setDialog(null)}
        />
      ) : null}
      {modelOpen ? (
        <OnboardingModelDialog runtime={{ id: "opencode", reasoning: OPENCODE_CATALOG } as never} model={model} onModelChange={setModel} onContinue={() => setModelOpen(false)} onExit={() => setModelOpen(false)} />
      ) : null}
    </>
  )
}

function UnavailableMachineLauncher() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Agent not detected</Button>
      {open ? (
        <OnboardingMachineDialog open harness="claude" harnessLabel="Claude Code" totalSteps={3}
          onConnected={noop} onChooseAnotherHarness={() => setOpen(false)} onManageMachines={() => setOpen(false)} onExit={() => setOpen(false)} />
      ) : null}
    </>
  )
}

function OnboardingSpecimens() {
  return (
    <div style={grid}>
      <Specimen label="Setup surface" note="Real onboarding shell; closes before network steps">
        <Pad><Scope machines={[ONLINE_MAC]}><OnboardingShellLaunchers /></Scope></Pad>
      </Specimen>
      <Specimen label="Setup preview flow" note="Shipped preview, no network; Esc closes">
        <Pad><Scope><OnboardingPreviewLaunchers /></Scope></Pad>
      </Specimen>
      <Specimen label="Machine and model steps" note="Standalone dialogs">
        <Pad>
          <div style={stack}>
            <Scope><MachineDialogLaunchers /></Scope>
            <Scope machines={[BROKEN_MAC]}><UnavailableMachineLauncher /></Scope>
          </div>
        </Pad>
      </Specimen>
      <Specimen label="Room setup status" note="Loading, error, success">
        <Pad><Scope><StatusDialogLaunchers /></Scope></Pad>
      </Specimen>
    </div>
  )
}

function TileSpecimens() {
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpMounted, setHelpMounted] = useState(false)
  const tiles = [
    ["Connect", "Machine empty state", <ConnectTile key="c" idPrefix="bv-connect" />],
    ["Create", "Bot empty state", <CreateTile key="cr" idPrefix="bv-create" />],
    ["Memory", "Help gallery slide", <MemoryTile key="m" idPrefix="bv-memory" />],
    ["Workspace", "Help gallery slide", <WorkspaceTile key="w" idPrefix="bv-workspace" />],
    ["Nap", "Help gallery slide", <NapTile key="n" idPrefix="bv-nap" />],
  ] as const
  return (
    <div style={grid}>
      {tiles.map(([label, note, tile]) => (
        <Specimen key={label} label={`${label} tile`} note={note}><Pad><TileSlot>{tile}</TileSlot></Pad></Specimen>
      ))}
      <Specimen label="How your agent works" note="Help gallery dialog">
        <Pad><Button onClick={() => { setHelpMounted(true); setHelpOpen(true) }}>Open gallery</Button></Pad>
      </Specimen>
      {helpMounted ? <AgentHelpGallery open={helpOpen} onOpenChange={setHelpOpen} /> : null}
    </div>
  )
}

function PairStepsSpecimen() {
  const states = [
    ["Generating", { command: "", generating: true, connectedHostname: null }],
    ["Command ready", { command: "npx --yes @alook/daemon@latest daemon start --machine-key mk_7F3C2A91", generating: false, connectedHostname: null }],
    ["Key failed", { command: "", generating: false, generationError: "Couldn't generate a key — try again.", connectedHostname: null }],
    ["Connected", { command: "npx --yes @alook/daemon@latest daemon start --machine-key mk_7F3C2A91", generating: false, connectedHostname: "gus-mbp" }],
  ] as const
  return (
    <>
      {states.map(([label, props]) => (
        <Specimen key={label} label={`Pair steps: ${label}`} note="PairMachineSteps">
          <Pad><div className="flex flex-col gap-6"><PairMachineSteps {...props} onRetry={noop} onCopy={noop} /></div></Pad>
        </Specimen>
      ))}
    </>
  )
}

function MachineDialogsSpecimen() {
  const [pair, setPair] = useState<null | PairMachineSheetMode>(null)
  const [pairOpen, setPairOpen] = useState(false)
  const [pendingTokenId, setPendingTokenId] = useState<string | null>(null)
  const [limit, setLimit] = useState<null | "pair" | "reconnect">(null)
  const [update, setUpdate] = useState<MachineSummary | null>(null)
  return (
    <Specimen label="Machine dialogs" note="Writes are blocked on this board, so the sheet shows its error path">
      <Pad>
        <div style={row}>
          <Button size="sm" onClick={() => { setPair({ kind: "pair" }); setPairOpen(true) }}>Pair sheet</Button>
          <Button size="sm" variant="outline" onClick={() => { setPair({ kind: "reconnect", machineId: "m-box", hostname: "studio" }); setPairOpen(true) }}>Reconnect sheet</Button>
          <Button size="sm" variant="outline" onClick={() => setLimit("pair")}>Limit</Button>
          <Button size="sm" variant="outline" onClick={() => setLimit("reconnect")}>Limit (reconnect)</Button>
          <Button size="sm" variant="outline" onClick={() => setUpdate(ONLINE_MAC)}>Update daemon</Button>
        </div>
      </Pad>
      {pair ? <PairMachineSheet open={pairOpen} onOpenChange={setPairOpen} mode={pair} pendingTokenId={pendingTokenId} setPendingTokenId={setPendingTokenId} connectedHostname={null} /> : null}
      <MachineLimitDialog open={limit !== null} onOpenChange={(next) => { if (!next) setLimit(null) }} onViewPlan={noop} limit={limit === "reconnect" ? 3 : 1} reconnect={limit === "reconnect"} />
      <MachineUpdateDialog machine={update} onOpenChange={(next) => { if (!next) setUpdate(null) }} onConfirm={() => setUpdate(null)} />
    </Specimen>
  )
}

function MachineSpecimens() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={grid}>
        <Specimen label="No machines yet" note="Real MachineList, empty; Guide me opens setup">
          <div style={contained(520)}>
            <Scope capacity={FREE_CAPACITY}><MachineList /><BoardOnboardingForm /></Scope>
          </div>
        </Specimen>
        <Specimen label="Machine list loading" note="MachineListSkeleton">
          <div style={contained(520)}><MachineListSkeleton /></div>
        </Specimen>
      </div>
      <div style={grid}>
        <Specimen label="Machine capacity" note="Hover for the plan popover">
          <Pad>
            <div style={stack}>
              <MachineCapacityUsage summary={HOUSE_CAPACITY} onViewPlan={noop} />
              <MachineCapacityUsage summary={FREE_CAPACITY} onViewPlan={noop} />
              <MachineCapacityUsage summary={null} onViewPlan={noop} />
            </div>
          </Pad>
        </Specimen>
        <Specimen label="Pair message diagram" note="Only messages leave the machine">
          <Pad><MachinePairMessageDiagram /></Pad>
        </Specimen>
        <Scope><MachineDialogsSpecimen /></Scope>
        <PairStepsSpecimen />
      </div>
    </div>
  )
}

function FailedConnection({ children }: { children: ReactNode }) {
  const runtime = useCommunityRuntime()
  useEffect(() => { runtime.ws.actions.setConnectionStatus("failed") }, [runtime])
  return <CommunityWsReconnectBoundary>{children}</CommunityWsReconnectBoundary>
}

function ShellSpecimens() {
  return (
    <div style={grid}>
      <Specimen label="Connecting" note="UnresolvedMainSkeleton with CommunityConnectingIndicator">
        <div style={contained(280)}><UnresolvedMainSkeleton /></div>
      </Specimen>
      <Specimen label="Connecting indicator" note="Bare indicator">
        <Pad><div className="grid place-items-center"><CommunityConnectingIndicator /></div></Pad>
      </Specimen>
      <Specimen label="Connection lost" note="WS reconnect overlay, contained">
        <div style={contained(280)}>
          <Fixtures><FailedConnection><div style={{ padding: 16 }} className="text-sm text-muted-foreground">Cached channel content</div></FailedConnection></Fixtures>
        </div>
      </Specimen>
    </div>
  )
}

function BillingSpecimens() {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetMounted, setSheetMounted] = useState(false)
  const [founderOffer, setFounderOffer] = useState<BillingSummary["offers"][number] | null>(null)
  return (
    <div style={grid}>
      <Specimen label="Plan: Founder" note="Choose a plan opens the founder dialog">
        <Pad><BillingContent billing={boardBilling(FOUNDER)} /></Pad>
      </Specimen>
      <Specimen label="Plan: subscribed" note="Scheduled change">
        <Pad><BillingContent billing={boardBilling(SUBSCRIBED)} /></Pad>
      </Specimen>
      <Specimen label="Billing dialogs" note="Bot plan limit, founder change">
        <Pad>
          <div style={row}>
            <Button size="sm" onClick={() => { setSheetMounted(true); setSheetOpen(true) }}>Plan limit</Button>
            <Button size="sm" variant="outline" onClick={() => setFounderOffer(OFFERS[0]!)}>Leave Founder</Button>
          </div>
        </Pad>
      </Specimen>
      {sheetMounted ? <BillingSheet open={sheetOpen} onOpenChange={setSheetOpen} limit={5} onViewPlan={noop} /> : null}
      <FounderPlanChangeDialog offer={founderOffer} busy={false} onCancel={() => setFounderOffer(null)} onConfirm={() => setFounderOffer(null)} />
    </div>
  )
}

export function AppOnboardingSpecimens(_props: { mode: "light" | "dark" }) {
  // Tiles, relative times and the GSAP timelines depend on the client; render after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <OnboardingSpecimens />
      <TileSpecimens />
      <MachineSpecimens />
      <ShellSpecimens />
      <BillingSpecimens />
    </div>
  )
}
