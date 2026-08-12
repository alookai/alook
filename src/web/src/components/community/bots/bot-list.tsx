"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronDown, ChevronLeft, Monitor, MoreVertical, HelpCircle, RotateCcw, Activity } from "lucide-react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { isPresenceOnline, formatModelLabel } from "@alook/shared"
import { machineName as resolveMachineName } from "@/lib/community/machine-name"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AgentAvatar } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { formatAwakeDuration } from "@/components/community/format-time"
import { BotActivityHeatmap } from "./bot-activity-heatmap"
import { useMachines } from "@/hooks/community/use-machines"
import { useBots, useDeleteBot, useResetBotSession, useResetMachineAgents, type BotSummary } from "@/hooks/community/use-bots"
import { useCreateOrGetDm } from "@/hooks/community/mutations"
import { useOnlineUserIds } from "@/stores/community/ws"
import { CreateBotSheet } from "./create-bot-sheet"
import { EditBotSheet } from "./edit-bot-sheet"
import { BotActivityModal } from "./bot-activity-modal"
import { BugReportDialog } from "./bug-report-dialog"
import { CreateTile } from "@/components/community/onboarding-tiles/create-tile"
import { AgentHelpGallery } from "@/components/community/onboarding-tiles/agent-help-gallery"
import {
  advanceCommunityOnboarding,
  readCommunityOnboardingState,
  recoverCommunityOnboardingMachine,
  updateCommunityOnboardingResources,
  useCommunityOnboarding,
} from "@/lib/community-onboarding"
import { tid } from "@/lib/community/testids"

/**
 * BotList — the /c/me/bots surface.
 *
 * Visual language matches the sibling MachineList: a back-bar header, a
 * 6-unit-padded scroll region, header/CTA row, Card rows with a 40px avatar,
 * status pill, meta line, and a kebab menu. Empty state matches the machine
 * empty state so users don't learn two idioms.
 */
// Loading placeholder shaped like a real bot Card (40px avatar + name row +
// meta line + trailing kebab slot) so the list doesn't reflow when data lands
// — replaces the old structureless muted box.
function BotCardSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className="h-3 w-48 rounded" />
        </div>
        <Skeleton className="size-8 shrink-0 rounded-md" />
      </div>
    </Card>
  )
}

export function BotList({ onBack }: { onBack?: () => void } = {}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const botsQuery = useBots()
  const { bots, isLoading } = botsQuery
  const { machines, isLoading: machinesLoading } = useMachines()
  // Presence read: single API for humans + bots, server-pushed identically
  // (see plans/community-account-debt-fixes.md Fix 3 — the owner is always
  // part of its own bots' presence audience, even for a bot not yet in any
  // shared server, so this pill uses the same signal every other surface
  // (DM sidebar, friend list, mention popover) reads from — no divergence).
  const onlineUserIds = useOnlineUserIds()
  const [createOpen, setCreateOpen] = useState(false)
  // `editingBot` deliberately never resets to null on close — EditBotSheet
  // stays mounted at all times (see its render below) so its open/close
  // transition always has a "closed" state to animate from, matching
  // CreateBotSheet. Only `editOpen` toggles; the last-edited bot lingers
  // harmlessly while the sheet is hidden.
  const [editingBot, setEditingBot] = useState<BotSummary | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [activityBot, setActivityBot] = useState<BotSummary | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const [bugReportBot, setBugReportBot] = useState<Pick<BotSummary, "id" | "name"> | null>(null)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<BotSummary | null>(null)
  const [confirmReset, setConfirmReset] = useState<BotSummary | null>(null)
  // Batch "reset all agents on this machine" confirm — keyed by machineId so the
  // dialog knows which group it's acting on (and can name it).
  const [confirmResetMachine, setConfirmResetMachine] = useState<string | null>(null)
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(
    () => new Set(),
  )
  const [helpOpen, setHelpOpen] = useState(false)
  const del = useDeleteBot()
  const resetSession = useResetBotSession()
  const resetMachineAgents = useResetMachineAgents()
  const createOrGetDm = useCreateOrGetDm()
  const onboardingState = useCommunityOnboarding()
  const guidedActive = onboardingState?.status === "active" && onboardingState.stage === "bot"
  const guidedPendingBotId =
    guidedActive ? onboardingState.botId : undefined
  const guidedNeedsMachine =
    guidedActive &&
    !machines.some((machine) => isPresenceOnline(machine.status))

  const chatWithBot = async (bot: BotSummary) => {
    try {
      const data = await createOrGetDm.mutateAsync({ userId: bot.id })
      router.push(`/c/me/${data.conversation.id}`)
    } catch (e) {
      toastApiError(e, "Failed to open chat")
    }
  }

  const openGuidedBotDm = async (botId: string) => {
    try {
      const data = await createOrGetDm.mutateAsync({ userId: botId })
      advanceCommunityOnboarding("bot", "dm", {
        botId,
        dmId: data.conversation.id,
      })
      router.push(`/c/me/${data.conversation.id}`)
    } catch (e) {
      toastApiError(e, "Bot created, but the chat couldn't open")
    }
  }

  const onBotCreated = async (bot: BotSummary) => {
    const state = readCommunityOnboardingState()
    if (state?.status !== "active" || state.stage !== "bot") return
    updateCommunityOnboardingResources({ botId: bot.id })
    await openGuidedBotDm(bot.id)
  }

  const openGuidedCreate = () => {
    const state = readCommunityOnboardingState()
    const hasUsableMachine = machines.some((machine) => isPresenceOnline(machine.status))
    if (state?.status === "active" && state.stage === "bot" && !hasUsableMachine) {
      recoverCommunityOnboardingMachine()
      router.push("/c/me/machines")
      return
    }
    if (state?.status === "active" && state.stage === "bot" && state.botId) {
      void openGuidedBotDm(state.botId)
      return
    }
    setCreateOpen(true)
  }

  const guidedCreateLabel = guidedNeedsMachine
    ? "Connect a machine"
    : guidedPendingBotId
      ? "Open bot chat"
      : "Create a bot"

  const machineName = (id: string): string => {
    const m = machines.find((x) => x.id === id)
    if (!m) return "Unknown machine"
    return resolveMachineName(m)
  }

  // Group bots by their bound machine, ordered to match the Machines page
  // (any bot whose machine no longer resolves — deleted/unbound — sorts
  // into a trailing "Unknown machine" group instead of disappearing).
  const groups = useMemo(() => {
    const byMachine = new Map<string, BotSummary[]>()
    for (const bot of bots) {
      const list = byMachine.get(bot.machineId)
      if (list) list.push(bot)
      else byMachine.set(bot.machineId, [bot])
    }
    const orderedIds = [
      ...machines.map((m) => m.id).filter((id) => byMachine.has(id)),
      ...[...byMachine.keys()].filter((id) => !machines.some((m) => m.id === id)),
    ]
    return orderedIds.map((machineId) => ({
      machineId,
      machine: machines.find((m) => m.id === machineId) ?? null,
      bots: byMachine.get(machineId)!,
    }))
  }, [bots, machines])

  // Deep-link from the machine-delete dialog's "Manage bots" action
  // (`?machineId=`) — scroll to that group and flash a highlight so the
  // user immediately sees which bots block the delete.
  const targetMachineId = searchParams.get("machineId")
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const scrolledForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!targetMachineId || bots.length === 0) return
    setCollapsedMachines((current) => {
      if (!current.has(targetMachineId)) return current
      const next = new Set(current)
      next.delete(targetMachineId)
      return next
    })
    if (scrolledForRef.current === targetMachineId) return
    scrolledForRef.current = targetMachineId
    groupRefs.current[targetMachineId]?.scrollIntoView({ behavior: "smooth", block: "start" })
    setHighlightId(targetMachineId)
    const t = setTimeout(() => setHighlightId(null), 2000)
    return () => clearTimeout(t)
  }, [targetMachineId, bots.length])

  const backBar = onBack ? (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Back"
      >
        <ChevronLeft className="size-5" />
      </Button>
      <span className="ml-1 truncate text-base font-semibold">My Bots</span>
    </header>
  ) : null

  if ((isLoading || machinesLoading) && bots.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-col gap-3 p-6">
          <BotCardSkeleton />
          <BotCardSkeleton />
          <BotCardSkeleton />
        </div>
      </div>
    )
  }

  if (bots.length === 0) {
    const needsMachine = machines.length === 0
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="w-full max-w-70 overflow-hidden rounded-xl">
            <div className="aspect-200/130 w-full">
              <CreateTile />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">
              {needsMachine ? "Connect a machine first" : "No bots yet"}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {needsMachine
                ? "Bots need a connected machine to run. Connect one first, then come back to create your bot."
                : "Create a bot and chat with it from anywhere — spin up servers and share it with family and friends."}
            </p>
          </div>
          {/* No help ? in the empty state (Gus): the gallery is about mechanics
              a user only needs AFTER they own a bot — it lives in the populated
              header instead. */}
          <div data-onboarding-target="create-bot" className="w-fit">
            <Button
              onClick={needsMachine ? () => router.push("/c/me/machines") : openGuidedCreate}
            >
              {needsMachine ? "Connect a machine" : guidedCreateLabel}
            </Button>
          </div>
        </div>
        <CreateBotSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={onBotCreated}
          guided={guidedActive}
          avatarSeed={guidedActive ? onboardingState.guideAvatarSeed : undefined}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {backBar}
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto thin-scrollbar p-6">
        <header className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-medium text-foreground">My Bots</h1>
            <p className="text-sm text-muted-foreground">
              Bots you own — they show up as friends and can be added to any server.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="How your agent works"
              onClick={() => setHelpOpen(true)}
              className="text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="size-5" />
            </Button>
            <div data-onboarding-target="create-bot" className="w-fit">
              <Button onClick={openGuidedCreate}>{guidedCreateLabel}</Button>
            </div>
          </div>
        </header>

        <div className="flex flex-col gap-6">
          {groups.map(({ machineId, machine, bots: machineBots }) => {
            const machineOnline = isPresenceOnline(machine?.status)
            const collapsed = collapsedMachines.has(machineId)
            const label = machineName(machineId)
            return (
              <div
                key={machineId}
                ref={(el) => {
                  groupRefs.current[machineId] = el
                }}
                className={[
                  "flex flex-col gap-3 rounded-lg p-1 transition-colors duration-500",
                  highlightId === machineId ? "bg-primary/5 ring-2 ring-primary/40" : "",
                ].join(" ")}
              >
                <div className="flex items-center gap-2 px-1">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
                    onClick={() => {
                      setCollapsedMachines((current) => {
                        const next = new Set(current)
                        if (next.has(machineId)) next.delete(machineId)
                        else next.add(machineId)
                        return next
                      })
                    }}
                  >
                    <ChevronDown
                      className={`size-3 shrink-0 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
                    />
                    <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs font-medium text-muted-foreground">
                      {label}
                    </span>
                    <span
                      className={[
                        "inline-block size-1.5 shrink-0 rounded-full",
                        machineOnline ? "bg-status-online" : "bg-muted-foreground",
                      ].join(" ")}
                    />
                  </button>
                  {/* Reset every agent bound to this machine in one command
                      (Gus #811). Idle bots get cold-started too (② semantics). */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setConfirmResetMachine(machineId)}
                  >
                    <RotateCcw className="size-3.5" />
                    Reset all
                  </Button>
                </div>
                <div className="flex flex-col gap-3" hidden={collapsed}>
                  {machineBots.map((bot) => {
                    const online = onlineUserIds.has(bot.id)
                    return (
                      <Card key={bot.id} className="flex flex-col gap-3 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={40} />
                          {/* The name/meta column and the heatmap share a
                              flex-wrap row that starts AFTER the avatar — so when
                              the strip wraps it aligns to the name column, not the
                              card's left edge under the avatar (Gus #726/#730).
                              The strip sits right of the meta when there's room
                              and drops to its own line below when the card is too
                              narrow (Gus #720) — native, content/width-based. */}
                          <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2.5">
                            {/* min-w = the meta line's natural width, so the strip
                                is forced to WRAP below before the runtime/model/
                                awake text has to truncate (Gus #730 — never let
                                the heatmap squeeze the meta). */}
                            <div className="flex min-w-55 flex-1 flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[15px] font-medium text-foreground">
                                  {bot.name}
                                </span>
                                <span
                                  className={[
                                    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium",
                                    online
                                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                      : "bg-muted text-muted-foreground",
                                  ].join(" ")}
                                >
                                  <span
                                    className={[
                                      "inline-block size-1.5 rounded-full",
                                      online ? "bg-status-online" : "bg-muted-foreground",
                                    ].join(" ")}
                                  />
                                  {online ? "Online" : "Offline"}
                                </span>
                                {/* A bot's presence is its bound machine's
                                status, so "bring online" jumps to Machines
                                and opens the same reconnect Sheet as
                                MachineCard's "Reconnect…". Omitted when the
                                machine can't be resolved (Unknown machine). */}
                                {!online && machine && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 shrink-0 px-2 text-xs"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      router.push(`/c/me/machines?reconnect=${machine.id}`)
                                    }}
                                  >
                                    Bring online
                                  </Button>
                                )}
                              </div>
                              {/* One meta line (Gus #573: no third row). Runtime ·
                                  model · awake-duration (my-bots #516; Gus
                                  #672/#674 relabelled "Refreshed X ago" → the
                                  awake concept "Awake 17h"). null lastRefresh =
                                  never awoke → the segment is omitted. The old
                                  "Handled N msgs" counter is replaced by the
                                  30-day activity heatmap (Gus #608). */}
                              {/* Meta wraps (not truncates): when the card is too
                                  narrow to fit runtime · model · Awake on one
                                  line, the segments fold to a second line instead
                                  of getting cut — provider/model are important
                                  info and must stay fully readable (Gus #730 /
                                  Alli #731). */}
                              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  <ProviderLogo provider={bot.runtime} className="size-3.5 shrink-0" />
                                  <span>{bot.runtime}</span>
                                </span>
                                <span aria-hidden className="shrink-0">·</span>
                                {formatModelLabel(bot.runtime, bot.modelName) ? (
                                  <span data-testid="bot-card-model" className="font-mono">
                                    {formatModelLabel(bot.runtime, bot.modelName)}
                                  </span>
                                ) : (
                                  <span
                                    data-testid="bot-card-model"
                                    className="font-mono text-muted-foreground/70"
                                    title="No model set — uses the machine's local default"
                                  >
                                    local default
                                  </span>
                                )}
                                {bot.lastRefreshContextAt && (
                                  <>
                                    <span aria-hidden className="shrink-0">·</span>
                                    <span className="shrink-0">{formatAwakeDuration(bot.lastRefreshContextAt)}</span>
                                  </>
                                )}
                              </span>
                            </div>
                            {/* The strip. No ml-auto: the id-column is flex-1 so
                                it eats the slack and pushes the strip to the
                                right when they share a line; when the row wraps,
                                the strip is alone on its line and left-aligns to
                                the name column (Gus #726/#730). self-center only
                                affects the shared line's vertical alignment. */}
                            <BotActivityHeatmap
                              days={bot.dailyActivity}
                              className="self-center"
                            />
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <button
                                  aria-label="Bot actions"
                                  className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                  <MoreVertical className="size-4" />
                                </button>
                              }
                            />
                            {/* Nav-icon pattern from message-menu (uiux #14,
                                Gus "less is more"): icon ONLY on the high-freq
                                actions (View activity, Reset) as scan anchors;
                                the rest render an icon-width placeholder so
                                every label shares one left edge. */}
                            <DropdownMenuContent align="end" className="w-auto min-w-36 max-w-56">
                              <DropdownMenuItem onClick={() => chatWithBot(bot)}>
                                <span className="size-4" aria-hidden /> Chat
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setActivityBot(bot)
                                  setActivityOpen(true)
                                }}
                              >
                                <Activity className="size-4" /> View activity
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditingBot(bot)
                                  setEditOpen(true)
                                }}
                              >
                                <span className="size-4" aria-hidden /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`bot-reset-session-item`}
                                onClick={() => setConfirmReset(bot)}
                              >
                                <RotateCcw className="size-4" /> Reset
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={tid.botReportProblemItem}
                                onClick={() => {
                                  setBugReportBot({ id: bot.id, name: bot.name })
                                  setBugReportOpen(true)
                                }}
                              >
                                <span className="size-4" aria-hidden /> Report a problem
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setConfirmDelete(bot)}
                              >
                                <span className="size-4" aria-hidden /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </Card>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <CreateBotSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={onBotCreated}
        guided={guidedActive}
        avatarSeed={guidedActive ? onboardingState.guideAvatarSeed : undefined}
      />
      <AgentHelpGallery open={helpOpen} onOpenChange={setHelpOpen} />
      <EditBotSheet bot={editingBot} open={editOpen} onOpenChange={setEditOpen} />
      <BotActivityModal
        bot={activityBot}
        open={activityOpen}
        onOpenChange={setActivityOpen}
      />
      {bugReportBot && (
        <BugReportDialog
          key={bugReportBot.id}
          bot={bugReportBot}
          open={bugReportOpen}
          onOpenChange={setBugReportOpen}
        />
      )}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot will leave every server it&apos;s in and its runner key will be
              revoked. Past messages remain in history with the bot&apos;s current name
              and avatar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!confirmDelete) return
                const name = confirmDelete.name
                try {
                  await del.mutateAsync(confirmDelete.id)
                  toast.success(`Deleted ${name}`)
                } catch (e) {
                  toastApiError(e, "Couldn't delete the bot")
                } finally {
                  setConfirmDelete(null)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!confirmReset}
        onOpenChange={(open) => !open && setConfirmReset(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this bot&apos;s session?</AlertDialogTitle>
            <AlertDialogDescription>
              Its running process will stop and it&apos;ll start a fresh session
              that picks up unfinished work from its notes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="bot-reset-confirm"
              onClick={async () => {
                if (!confirmReset) return
                try {
                  await resetSession.mutateAsync(confirmReset.id)
                  toast.success("Session reset.")
                } catch (e) {
                  const status = (e as { status?: number } | undefined)?.status
                  const message = (e as { message?: string } | undefined)?.message ?? ""
                  if (status === 409 && message.toLowerCase().includes("offline")) {
                    toast.error("Bot is offline — bring it online before resetting.")
                  } else {
                    toastApiError(e, "Couldn't reset the bot's session")
                  }
                } finally {
                  setConfirmReset(null)
                }
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!confirmResetMachine}
        onOpenChange={(open) => !open && setConfirmResetMachine(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset all agents on {confirmResetMachine ? machineName(confirmResetMachine) : "this machine"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every agent on this machine will start a fresh session. Any that
              aren&apos;t currently running will be woken too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="machine-reset-all-confirm"
              onClick={async () => {
                if (!confirmResetMachine) return
                const name = machineName(confirmResetMachine)
                try {
                  const { dispatched } = await resetMachineAgents.mutateAsync(confirmResetMachine)
                  toast.success(
                    `Dispatched reset to ${dispatched} agent${dispatched === 1 ? "" : "s"} on ${name}.`,
                  )
                } catch (e) {
                  const status = (e as { status?: number } | undefined)?.status
                  const message = (e as { message?: string } | undefined)?.message ?? ""
                  if (status === 409 && message.toLowerCase().includes("offline")) {
                    toast.error(`${name} is offline — bring it online before resetting.`)
                  } else {
                    toastApiError(e, "Couldn't reset the machine's agents")
                  }
                } finally {
                  setConfirmResetMachine(null)
                }
              }}
            >
              Reset all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
