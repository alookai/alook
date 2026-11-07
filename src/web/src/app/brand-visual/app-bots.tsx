"use client"
import type { BotRuntimeOption } from "@/lib/community/machines"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { PiiPlugin, QuotaLimit, ReasoningEffort } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { CreateBotSheet } from "@/components/community/bots/create-bot-sheet"
import { EditBotSheet } from "@/components/community/bots/edit-bot-sheet"
import { BotAvatarPickerDialog } from "@/components/avatar/bot-avatar-picker-dialog"
import { ModelField } from "@/components/community/bots/model-field"
import { ReasoningEffortField } from "@/components/community/bots/reasoning-effort-field"
import { BotRuntimeFields } from "@/components/community/bots/bot-runtime-fields"
import { BotMachineField } from "@/components/community/bots/bot-machine-field"
import { BotActivityModal } from "@/components/community/bots/bot-activity-modal"
import { BotActivityHeatmap } from "@/components/community/bots/bot-activity-heatmap"
import { BotTokenUsageHeatmap } from "@/components/community/bots/bot-token-usage-chart"
import { BotMembershipsSheet } from "@/components/community/bots/bot-memberships-sheet"
import { BotPiiPanel } from "@/components/community/bots/bot-pii-panel"
import { BotPiiList } from "@/components/community/bots/bot-pii-list"
import { BotPiiPlayground } from "@/components/community/bots/bot-pii-playground"
import { BugReportDialog } from "@/components/community/bots/bug-report-dialog"
import { MachineQuotaSummary } from "@/components/community/bots/bot-quota-summary"
import { BotActiveSummary } from "@/components/community/bots/bot-active-summary"
import type { BotPlanSummary, BotSummary, BotTokenUsage } from "@/hooks/community/use-bots"
import type { MachineBackendQuota, MachineSummary } from "@/hooks/community/use-machines"
import type { BugReportPhase } from "@/hooks/community/use-bot-bug-report"
import type { AuditEvent } from "@/hooks/community/use-bot-audit-log"
import type { BotActivityDay } from "@/lib/community/models/people"
import type { AvatarDraft } from "@/lib/avatar/model"
import { communityKeys } from "@/lib/query-keys"
import { DEMO_PROFILES } from "@/components/home/landing-interactive-shell-data"
import { Fixtures, Specimen } from "./app-components"

const DAY = 864e5
const dayKey = (offset: number) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10)
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 6e4).toISOString()
/** Board-only cache seeds never go stale, so no query ever hits the network. */
const FRESH = { updatedAt: Date.now() + 365 * DAY }

const CLAUDE_CATALOG = {
  catalogOrigin: "native_report" as const,
  updateMode: "live_next_turn" as const,
  defaultModelId: "claude-opus-5-5",
  models: [
    { id: "claude-opus-5-5", displayName: "Opus 5.5", supportedReasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high", description: "Deeper thinking" }, { value: "max" }], defaultReasoningEffort: "medium" },
    { id: "claude-sonnet-5", displayName: "Sonnet 5", supportedReasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }], defaultReasoningEffort: "medium" },
    { id: "claude-haiku-5", displayName: "Haiku 5", supportedReasoningEfforts: [] },
  ],
}
const CODEX_CATALOG = {
  catalogOrigin: "native_report" as const,
  updateMode: "context_preserving_restart" as const,
  defaultModelId: "gpt-5.5-codex",
  models: [
    { id: "gpt-5.5-codex", displayName: "GPT-5.5 Codex", supportedReasoningEfforts: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }], defaultReasoningEffort: "medium" },
  ],
}

const quotaLimit = (id: string, window: string, seconds: number, used: number, resetHours: number): QuotaLimit => ({
  bucket: {
    limitId: id,
    product: { kind: "reported", id: "max", displayName: "Max plan" },
    model: { kind: "not_applicable" },
    window: { kind: "rolling", durationSeconds: seconds, displayName: window },
  },
  usedPercent: used,
  resetsAt: new Date(Date.now() + resetHours * 36e5).toISOString(),
})
const QUOTA: MachineBackendQuota[] = [
  {
    scope: { kind: "machine_backend", machineId: "m-mac", agentBackendId: "claude" },
    capability: "supported", runtimeState: "healthy",
    snapshot: { status: "available", observedAt: iso(3), planName: "Max", limits: [quotaLimit("five-hour", "5-hour", 18000, 42, 2), quotaLimit("weekly", "Weekly", 604800, 71, 70)] },
  },
  {
    scope: { kind: "machine_backend", machineId: "m-mac", agentBackendId: "codex" },
    capability: "supported", runtimeState: "healthy",
    snapshot: { status: "stale", observedAt: iso(90), planName: "Pro", limits: [quotaLimit("codex-five-hour", "5-hour", 18000, 12, 4)] },
  },
]
const QUOTA_PENDING: MachineBackendQuota[] = [
  { scope: { kind: "machine_backend", machineId: "m-box", agentBackendId: "claude" }, capability: "supported", runtimeState: "offline", snapshot: { status: "pending" } },
]

const MACHINES = [
  {
    id: "m-mac", displayName: "Gus's MacBook", hostname: "gus-mbp", platform: "darwin", arch: "arm64", osRelease: "23.6.0", daemonVersion: "0.9.4",
    createdAt: iso(60 * 24 * 40), updatedAt: iso(5), status: "online", lastSeenAt: iso(0),
    availableRuntimes: [
      { id: "claude", version: "2.1.0", status: "healthy", reasoning: CLAUDE_CATALOG },
      { id: "codex", version: "0.42.0", status: "healthy", reasoning: CODEX_CATALOG },
    ],
    quota: QUOTA,
  },
  {
    id: "m-box", displayName: "Studio box", hostname: "studio", platform: "linux", arch: "x64", osRelease: "6.8.0", daemonVersion: "0.9.1",
    createdAt: iso(60 * 24 * 80), updatedAt: iso(300), status: "offline", lastSeenAt: iso(300),
    availableRuntimes: [{ id: "claude", version: "2.0.9", status: "unhealthy", lastError: "not signed in" }],
  },
] as unknown as MachineSummary[]

const RUNTIME_OPTIONS: BotRuntimeOption[] = [
  { id: "claude", reasoning: CLAUDE_CATALOG, unhealthy: false },
  { id: "codex", reasoning: CODEX_CATALOG, unhealthy: false },
  { id: "gemini", unhealthy: true },
] as unknown as BotRuntimeOption[]

const alli = DEMO_PROFILES.get("demo-alli")
const ACTIVITY: BotActivityDay[] = Array.from({ length: 30 }, (_, i) => i)
  .filter((i) => i % 4 !== 3)
  .map((i) => ({ day: dayKey(i), handledCount: (i * 7) % 23, sentCount: (i * 5) % 17 }))
  .reverse()
const USAGE: BotTokenUsage = {
  capability: "supported",
  days: Array.from({ length: 30 }, (_, i) => 29 - i).map((offset) => ({
    day: dayKey(offset),
    period: offset === 0 ? "in_progress" as const : "closed" as const,
    metrics: offset % 6 === 5
      ? { input: 0, output: 0, cache: 0 }
      : { input: 40_000 + ((offset * 9173) % 260_000), output: 6_000 + ((offset * 3307) % 48_000), cache: offset % 5 === 0 ? null : 120_000 + ((offset * 15101) % 900_000) },
  })),
}
const BOT: BotSummary = {
  id: "demo-alli", name: alli?.name ?? "Alli", description: alli?.aboutMe ?? "The designer.", image: alli?.avatar ?? "avatar:beam:Alli",
  avatarVersion: 0, machineId: "m-mac", runtime: "claude", modelName: "claude-opus-5-5", reasoningEffort: "high", runtimeConfigRevision: 3,
  isActive: true, presence: "online", lastRefreshContextAt: iso(60 * 17), dailyActivity: ACTIVITY, usage: USAGE,
}
const PLAN: BotPlanSummary = { isFounder: false, plan: { id: "plus", displayName: "Plus" }, limit: 5, ownedCount: 4, activeCount: 3 }

const AUDIT: AuditEvent[] = ([
  ["wake_trigger", { channel: "/Studio#4012/design-review", seq: 412, senderHandle: "@gus#1813", reason: "mention" }, 42],
  ["thinking", { text: "Gus wants the hero to lead with the beige Mac. Check the poster grid first." }, 41],
  ["cli_invocation", { subcommand: "inboxPull" }, 41],
  ["tool_call", { name: "Read", target: "src/web/src/app/brand-visual/brand-visual.tsx" }, 40],
  ["tool_call", { name: "Bash", target: "npx tsc --noEmit -p ." }, 38],
  ["text", { text: "The Mac reads warmer. I moved the sticker to the lower right so the headline keeps its edge." }, 36],
  ["cli_invocation", { subcommand: "messageSend" }, 36],
  ["cli_invocation", { subcommand: "messagePropertySet", propertyType: "emoji" }, 35],
  ["model_changed", { from: "claude-sonnet-5", to: "claude-opus-5-5" }, 30],
  ["error", { scope: "runtime", code: "RATE_LIMITED", message: "Provider rate limit reached", model: "claude-opus-5-5" }, 22],
  ["turn_interrupt", null, 20],
  ["nap", null, 12],
  ["wake_trigger", { channel: "/.dm/gus#1813", seq: 88, senderHandle: "@gus#1813", reason: "unread" }, 4],
  ["text", { text: "Pulled the latest board. Three specimens still clip on narrow phones; notes attached.", truncated: true, chars: 340 }, 3],
] as const).map(([kind, payload, minutesAgo], i) => ({ id: `audit-${String(i).padStart(2, "0")}`, kind, payload, sessionId: "s-1", launchId: "l-1", createdAt: iso(minutesAgo) }))

const MEMBERSHIPS = {
  servers: [
    { id: "srv-studio", name: "Studio", handle: "Studio#4012", icon: null, canLeave: true, channels: [
      { id: "/Studio#4012/general", name: "general", type: "text" as const, canLeave: false },
      { id: "/Studio#4012/design-review", name: "design-review", type: "text" as const, canLeave: true },
      { id: "/Studio#4012/ideas", name: "ideas", type: "forum" as const, canLeave: false },
    ] },
    { id: "srv-coffee", name: "Coffee map", handle: "Coffee#2210", icon: null, canLeave: true, channels: [
      { id: "/Coffee#2210/coffee-map", name: "coffee-map", type: "text" as const, canLeave: false },
    ] },
  ],
}

const PII_PLUGINS: PiiPlugin[] = [
  { id: "email", name: "Email addresses", description: "Replaces email addresses with a redaction mark.", enabled: true },
  { id: "phone", name: "Phone numbers", description: "Masks phone numbers in common international formats.", enabled: true },
  { id: "api-keys", name: "API keys", description: "Hides strings that look like provider secret keys (sk-…, ghp_…).", enabled: false },
]
const PII_INPUT = "Ping me at gus@example.com or +1 415 555 0134 when the poster is ready."
const PII_OUTPUT = "Ping me at ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ or ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ when the poster is ready."

function seedBoardCache(client: QueryClient) {
  client.setQueryData(communityKeys.machines(), { machines: MACHINES, complete: true, observed: true, source: "network" }, FRESH)
  client.setQueryData([...communityKeys.machines(), "observations"], { quotas: [{ machineId: "m-mac", quota: QUOTA }] }, FRESH)
  client.setQueryData(communityKeys.botAuditLog(BOT.id), { pages: [{ events: [...AUDIT].reverse(), nextCursor: null }], pageParams: [null] }, FRESH)
}

const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 16, alignItems: "start" }
const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }
const panel: CSSProperties = { width: "100%", maxWidth: 360, minWidth: 0 }
const pad: CSSProperties = { padding: 16, minWidth: 0 }

function Pad({ children }: { children: ReactNode }) {
  return <div style={pad}>{children}</div>
}

function Seeded({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const [ready, setReady] = useState(false)
  useEffect(() => { seedBoardCache(client); setReady(true) }, [client])
  return ready ? <>{children}</> : null
}

function SheetLaunchers() {
  const client = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [createMounted, setCreateMounted] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editMounted, setEditMounted] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityMounted, setActivityMounted] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [membersMounted, setMembersMounted] = useState(false)
  const [bug, setBug] = useState<BugReportPhase | null>(null)
  return (
    <>
      <Specimen label="Create and edit" note="Real sheets on seeded machines"><Pad>
        <div style={row}>
          <Button onClick={() => { setCreateMounted(true); setCreateOpen(true) }}>Create bot</Button>
          <Button variant="outline" onClick={() => { setEditMounted(true); setEditOpen(true) }}>Edit bot</Button>
        </div>
      </Pad></Specimen>
      <Specimen label="Activity and memberships" note="Audit log and joined spaces"><Pad>
        <div style={row}>
          <Button variant="outline" onClick={() => { setActivityMounted(true); setActivityOpen(true) }}>Bot activity</Button>
          <Button variant="outline" onClick={() => {
            client.setQueryData(communityKeys.botMemberships(BOT.id), MEMBERSHIPS, FRESH)
            setMembersMounted(true); setMembersOpen(true)
          }}>Servers & channels</Button>
        </div>
      </Pad></Specimen>
      <Specimen label="Bug report" note="Each dialog phase"><Pad>
        <div style={row}>
          {(["confirm", "collecting", "uploaded", "failed", "timeout"] as const).map((phase) => (
            <Button key={phase} size="sm" variant="outline" onClick={() => setBug(phase)}>{phase[0]!.toUpperCase() + phase.slice(1)}</Button>
          ))}
        </div>
      </Pad></Specimen>
      {createMounted ? <CreateBotSheet open={createOpen} onOpenChange={setCreateOpen} avatarSeed="Pixel" onCreated={() => setCreateOpen(false)} /> : null}
      {editMounted ? <EditBotSheet bot={BOT} open={editOpen} onOpenChange={setEditOpen} /> : null}
      {activityMounted ? <BotActivityModal bot={BOT} open={activityOpen} onOpenChange={setActivityOpen} onOpenChangeComplete={() => {}} /> : null}
      {membersMounted ? <BotMembershipsSheet bot={{ id: BOT.id, name: BOT.name, image: BOT.image }} open={membersOpen} onOpenChange={setMembersOpen} /> : null}
      {bug ? (
        <BugReportDialog bot={{ id: BOT.id, name: BOT.name }} open phase={bug} isSubmitting={false}
          reportId={bug === "uploaded" ? "rpt_7F3C2A91" : null} errorCode={bug === "failed" ? "rate_limited" : null}
          onConfirm={() => setBug("collecting")} onOpenChange={(next) => { if (!next) setBug(null) }} />
      ) : null}
    </>
  )
}

function FormFieldSpecimens() {
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "procedural", image: BOT.image ?? "" })
  const [machineId, setMachineId] = useState("m-mac")
  const [runtime, setRuntime] = useState("claude")
  const [model, setModel] = useState<string | null>("claude-opus-5-5")
  const [effort, setEffort] = useState<ReasoningEffort | null>("high")
  const [soloModel, setSoloModel] = useState<string | null>(null)
  const [soloEffort, setSoloEffort] = useState<ReasoningEffort | null>(null)
  const claude = RUNTIME_OPTIONS[0]!
  return (
    <>
      <Specimen label="Avatar picker" note="Click the avatar"><Pad>
        <BotAvatarPickerDialog image={avatar.kind === "photo" ? null : avatar.image} onChange={setAvatar} />
      </Pad></Specimen>
      <Specimen label="Machine field" note="Online and offline"><Pad>
        <div style={panel}><BotMachineField machines={MACHINES} machineId={machineId} onChange={setMachineId} radioName="board-bot-machine" /></div>
      </Pad></Specimen>
      <Specimen label="Runtime fields" note="Provider, model, effort"><Pad>
        <div style={panel}>
          <BotRuntimeFields options={RUNTIME_OPTIONS} runtime={runtime} model={model} daemonVersion="0.9.4" machineId="m-mac"
            reasoningEffort={effort} onRuntimeChange={(next) => { setRuntime(next); setModel(null); setEffort(null) }}
            onModelChange={setModel} onReasoningEffortChange={setEffort} radioName="board-bot-runtime" />
        </div>
      </Pad></Specimen>
      <Specimen label="Model field" note="Standalone, with an error"><Pad>
        <div style={{ ...panel, ...stack }}>
          <ModelField runtime={claude} value={soloModel} onChange={setSoloModel} />
          <ModelField runtime={claude} value={null} onChange={() => {}} error="Choose a model for this provider." />
        </div>
      </Pad></Specimen>
      <Specimen label="Reasoning effort" note="Standalone"><Pad>
        <div style={panel}>
          <ReasoningEffortField runtime={claude} model="claude-opus-5-5" daemonVersion="0.9.4" value={soloEffort} onChange={setSoloEffort} />
        </div>
      </Pad></Specimen>
    </>
  )
}

function UsageSpecimens() {
  return (
    <>
      <Specimen label="Activity heatmap" note="30 days, handled and sent"><Pad>
        <div style={row}><BotActivityHeatmap days={ACTIVITY} /><BotActivityHeatmap days={[]} /></div>
      </Pad></Specimen>
      <Specimen label="Token usage" note="30 days; hover a day. Unsupported renders nothing."><Pad>
        <BotTokenUsageHeatmap botId={BOT.id} usage={USAGE} />
      </Pad></Specimen>
      <Specimen label="Machine quota" note="Click for details"><Pad>
        <div style={stack}>
          <MachineQuotaSummary machineId="m-mac" entries={QUOTA} />
          <MachineQuotaSummary machineId="m-box" entries={QUOTA_PENDING} />
          <MachineQuotaSummary machineId="m-none" entries={[]} />
        </div>
      </Pad></Specimen>
      <Specimen label="Active bots" note="Hover for the plan"><Pad>
        <div style={stack}>
          <BotActiveSummary summary={PLAN} />
          <BotActiveSummary summary={{ ...PLAN, activeCount: 5, ownedCount: 7 }} isFounder />
          <BotActiveSummary summary={null} />
        </div>
      </Pad></Specimen>
    </>
  )
}

function PiiSpecimen() {
  const bots = ["demo-alli", "demo-cecilia", "demo-claudette"].map((id) => {
    const p = DEMO_PROFILES.get(id)
    return { id, name: p?.name ?? id, image: p?.avatar ?? null }
  })
  const [selected, setSelected] = useState("demo-alli")
  const [plugins, setPlugins] = useState(PII_PLUGINS)
  const [input, setInput] = useState(PII_INPUT)
  const [result, setResult] = useState<string | undefined>(PII_OUTPUT)
  const name = bots.find((b) => b.id === selected)?.name ?? ""
  const empty = selected === "demo-claudette"
  return (
    <Specimen label="Privacy filters" note="Panel, list, playground. Pick Claudette for the empty list.">
      <div style={{ width: "100%", height: 1080, display: "flex", minHeight: 0 }}>
        <BotPiiPanel bots={bots} selectedId={selected} onSelect={setSelected}>
          <section style={stack}>
            <h3 className="text-base font-medium">PII steps</h3>
            <BotPiiList botName={name} plugins={empty ? [] : plugins} pending={false}
              unavailable={selected === "demo-cecilia" ? "Cecilia's machine is offline. Filters load when it reconnects." : undefined}
              onSetEnabled={(id, enabled) => setPlugins((xs) => xs.map((x) => x.id === id ? { ...x, enabled } : x))}
              onDelete={async (id) => { setPlugins((xs) => xs.filter((x) => x.id !== id)); return true }} />
          </section>
          <section style={stack}>
            <h3 className="text-base font-medium">Playground</h3>
            <BotPiiPlayground value={input} onValueChange={(v) => { setInput(v); setResult(undefined) }} result={result}
              triggeredFilters={result ? [{ id: "email", name: "Email addresses" }, { id: "phone", name: "Phone numbers" }] : undefined}
              pending={false} disabled={empty} onRun={() => setResult(PII_OUTPUT)} />
          </section>
        </BotPiiPanel>
      </div>
    </Specimen>
  )
}

export function AppBotsSpecimens(_props: { mode: "light" | "dark" }) {
  // Heatmaps and relative times depend on the clock; render after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return (
    <Fixtures>
      <Seeded>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={grid}><SheetLaunchers /></div>
          <div style={grid}><FormFieldSpecimens /></div>
          <div style={grid}><UsageSpecimens /></div>
          <PiiSpecimen />
        </div>
      </Seeded>
    </Fixtures>
  )
}
