"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { ChevronLeft } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import type { AlookMode, CommunityMachineSummary } from "@alook/shared"
import {
  isPresenceOnline,
  releaseVersionGte,
  SELF_UPDATE_MIN_DAEMON_VERSION,
} from "@alook/shared"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { GeneratedAvatar } from "@/components/avatar"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { apiFetch, getErrorMessage } from "@/lib/api/client"
import { fetchLatestDaemonVersion } from "@/lib/api/config"
import { getAppMode } from "@/lib/utils"
import { machineName } from "@/lib/community/machine-name"
import { MachineCard } from "./machine-card"
import { PairMachineSheet, type PairMachineSheetMode } from "./pair-machine-sheet"
import { ConnectTile } from "@/components/community/onboarding-tiles/connect-tile"
import { useMachines, type MachinesResponse } from "@/hooks/community/use-machines"
import { useBots } from "@/hooks/community/use-bots"
import { useCommunityStore, usePendingMachineTokenId } from "@/stores/community"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import {
  advanceCommunityOnboarding,
  readCommunityOnboardingState,
  startCommunityOnboarding,
  updateCommunityOnboardingResources,
  useCommunityOnboarding,
} from "@/lib/community-onboarding"
import { removeCommunityParam } from "@/lib/community/community-route"

// Loading placeholder shaped like a real MachineCard (size-10 rounded-xl icon +
// name row + meta lines + trailing kebab slot) so the list doesn't reflow when
// data lands — replaces the old structureless muted box.
function MachineCardSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Skeleton className="size-10 shrink-0 rounded-xl" />
          <div className="flex flex-col gap-2 py-0.5">
            <Skeleton className="h-3.5 w-32 rounded" />
            <Skeleton className="h-3 w-44 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </div>
        </div>
        <Skeleton className="size-8 shrink-0 rounded-md" />
      </div>
    </Card>
  )
}

export function canUpdateMachine(
  machine: Pick<CommunityMachineSummary, "status" | "daemonVersion">,
  latestVersion: string | null,
  controllerMode: AlookMode,
): boolean {
  const currentVersion = machine.daemonVersion
  if (controllerMode === "dev" || !isPresenceOnline(machine.status) || !currentVersion || !latestVersion) {
    return false
  }
  return (
    releaseVersionGte(currentVersion, SELF_UPDATE_MIN_DAEMON_VERSION) &&
    releaseVersionGte(latestVersion, currentVersion) &&
    !releaseVersionGte(currentVersion, latestVersion)
  )
}

export async function requestMachineUpdate(machineId: string): Promise<boolean> {
  try {
    await apiFetch<{ dispatched: true }>(`/api/community/machines/${machineId}/update`, {
      method: "POST",
    })
    toast.success("Update requested — the machine will restart and reconnect")
    return true
  } catch (error) {
    toast.error(getErrorMessage(error, "Couldn't request the daemon update"))
    return false
  }
}

export function MachineUpdateDialog({
  machine,
  onOpenChange,
  onConfirm,
}: {
  machine: CommunityMachineSummary | null
  onOpenChange: (open: boolean) => void
  onConfirm: (machine: CommunityMachineSummary) => void
}) {
  return (
    <AlertDialog open={!!machine} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Update daemon on {machine ? machineName(machine) : "machine"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The daemon will restart, and any agents currently running on this machine will stop.
            The machine will reconnect automatically when the update is ready.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOpenChange(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid={tid.machineUpdateConfirm}
            onClick={() => machine && onConfirm(machine)}
          >
            Update daemon
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function MachineList({ onBack }: { onBack?: () => void } = {}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const { machines, isLoading: machinesLoading } = useMachines()
  const { bots } = useBots()
  const pendingMachineTokenId = usePendingMachineTokenId()
  const [pairOpen, setPairOpen] = useState(false)
  const [pairMode, setPairMode] = useState<PairMachineSheetMode>({ kind: "pair" })
  const [pendingTokenId, setPendingTokenId] = useState<string | null>(null)
  const [connectedHostname, setConnectedHostname] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<CommunityMachineSummary | null>(null)
  const [confirmUpdate, setConfirmUpdate] = useState<CommunityMachineSummary | null>(null)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [guideAvatarSeed, setGuideAvatarSeed] = useState("alook-guide")
  const onboardingState = useCommunityOnboarding()
  const controllerMode = getAppMode()

  useEffect(() => {
    setGuideAvatarSeed(`alook-guide-${crypto.randomUUID()}`)
  }, [])

  useEffect(() => {
    if (controllerMode === "dev") return
    let active = true
    void fetchLatestDaemonVersion()
      .then(({ version }) => {
        if (active) setLatestVersion(version)
      })
      .catch(() => {
        if (active) setLatestVersion(null)
      })
    return () => {
      active = false
    }
  }, [controllerMode])

  // When the WS layer announces a machine for our pending token, flip the sheet.
  useEffect(() => {
    if (!pendingTokenId) return
    const justConnected = machines.find(
      (m) =>
        m.lastSeenAt &&
        isPresenceOnline(m.status) &&
        pendingMachineTokenId === pendingTokenId
    )
    if (justConnected && !connectedHostname) {
      setConnectedHostname(justConnected.hostname || "machine")
      const onboarding = readCommunityOnboardingState()
      let continueOnboarding = false
      if (onboarding?.status === "active" && onboarding.stage === "machine") {
        advanceCommunityOnboarding("machine", "bot")
        continueOnboarding = true
      } else if (
        onboarding?.status === "active" &&
        onboarding.stage === "bot" &&
        onboarding.machineRecovery
      ) {
        updateCommunityOnboardingResources({ machineRecovery: false })
        continueOnboarding = true
      }
      if (continueOnboarding) {
        useCommunityStore.getState().uiHandlers.navigatePath?.("/c/me/bots")
      }
    }
  }, [machines, pendingMachineTokenId, pendingTokenId, connectedHostname])

  const openPair = useCallback(() => {
    setPairMode({ kind: "pair" })
    setPendingTokenId(null)
    setConnectedHostname(null)
    useCommunityStore.getState().setPendingMachineTokenId(null)
    setPairOpen(true)
  }, [])

  const openReconnect = useCallback((machine: CommunityMachineSummary) => {
    setPairMode({
      kind: "reconnect",
      machineId: machine.id,
      hostname: machine.hostname || "machine",
    })
    setPendingTokenId(null)
    setConnectedHostname(null)
    useCommunityStore.getState().setPendingMachineTokenId(null)
    setPairOpen(true)
  }, [])

  // Deep-link from BotList's "Bring online" button (`?reconnect=<machineId>`)
  // — auto-open the same reconnect Sheet MachineCard's "Reconnect…" opens.
  // Cleared via replace() once handled so a refresh/back-nav doesn't reopen
  // it; a one-shot ref keyed by the param value stops it re-firing while
  // `machines` refetches in the background before the replace lands.
  const handledReconnectRef = useRef<string | null>(null)
  useEffect(() => {
    const reconnectId = searchParams.get("reconnect")
    if (!reconnectId || handledReconnectRef.current === reconnectId || machinesLoading) return
    handledReconnectRef.current = reconnectId
    const machine = machines.find((m) => m.id === reconnectId)
    if (machine) openReconnect(machine)
    const search = searchParams.toString()
    const href = `/c/me/machines${search ? `?${search}` : ""}`
    router.replace(removeCommunityParam(href, "reconnect"))
  }, [searchParams, machines, machinesLoading, openReconnect, router])

  const closePair = useCallback((open: boolean) => {
    setPairOpen(open)
    if (!open) {
      setPendingTokenId(null)
      setConnectedHostname(null)
      useCommunityStore.getState().setPendingMachineTokenId(null)
    }
  }, [])

  const onConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return
    const id = confirmDelete.id
    setConfirmDelete(null)
    try {
      // Never sends `cascade: true` — deleting a machine with live bots on
      // it is blocked (see the dialog below, which swaps the destructive
      // action out for "Manage bots" whenever `botsToDelete` is non-empty).
      // This call only fires for a machine we already know has zero bots.
      await apiFetch(`/api/community/machines/${id}`, { method: "DELETE" })
      // Optimistically drop the row from the machines cache. WS
      // `machine.removed` fans out and reconciles, but the same-tab actor
      // should see it disappear immediately.
      queryClient.setQueryData<MachinesResponse | undefined>(
        communityKeys.machines(),
        (prev) =>
          prev ? { ...prev, machines: prev.machines.filter((m) => m.id !== id) } : prev,
      )
    } catch (err) {
      // MACHINE_HAS_BOTS can still happen here despite the client-side
      // guard above — e.g. a bot was created on this machine from another
      // tab between opening the dialog and confirming.
      const message =
        err instanceof Error && err.message === "MACHINE_HAS_BOTS"
          ? "This machine now has bots on it — delete or move them first"
          : err instanceof Error && err.message
            ? err.message
            : "Couldn't delete the machine"
      toast.error(message)
    }
  }, [confirmDelete, queryClient])

  const handleSetPendingTokenId = useCallback((tokenId: string | null) => {
    setPendingTokenId(tokenId)
    useCommunityStore.getState().setPendingMachineTokenId(tokenId)
  }, [])

  const onConfirmUpdate = useCallback((machine: CommunityMachineSummary) => {
    setConfirmUpdate(null)
    void requestMachineUpdate(machine.id)
  }, [])

  const botsToDelete = confirmDelete
    ? bots.filter((b) => b.machineId === confirmDelete.id)
    : []

  const backBar = onBack ? (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6">
      <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back">
        <ChevronLeft className="size-5" />
      </Button>
      <span className="ml-1 truncate text-base font-semibold">Machines</span>
    </header>
  ) : null

  if (machinesLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-col gap-3 p-6">
          <MachineCardSkeleton />
          <MachineCardSkeleton />
          <MachineCardSkeleton />
        </div>
      </div>
    )
  }

  if (machines.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="w-full max-w-70 overflow-hidden rounded-xl">
            <div className="aspect-200/130 w-full">
              <ConnectTile />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">No machines yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Connect a machine and your bots run on it always-on — reach them from
              your phone or anywhere, wherever you sign in.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              data-onboarding-target="connect-machine"
              data-testid={tid.machinePairOpen}
              onClick={openPair}
            >
              Connect a machine
            </Button>
            <span className="community-guide-me">
              {onboardingState === null ? (
                <span className="community-guide-me-orbit" aria-hidden="true">
                  <span className="community-guide-me-avatar">
                    <GeneratedAvatar
                      seed={guideAvatarSeed}
                      size={24}
                      className="rounded-full ring-2 ring-background shadow-sm"
                    />
                  </span>
                </span>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => startCommunityOnboarding({ guideAvatarSeed })}
              >
                Guide me
              </Button>
            </span>
          </div>
        </div>
        <PairMachineSheet
          open={pairOpen}
          onOpenChange={closePair}
          pendingTokenId={pendingTokenId}
          setPendingTokenId={handleSetPendingTokenId}
          connectedHostname={connectedHostname}
          mode={pairMode}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {backBar}
      <div className="flex flex-1 flex-col gap-6 p-6 overflow-y-auto thin-scrollbar">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-medium text-foreground">Machines</h1>
            <p className="text-sm text-muted-foreground">
              Your computers running the alook daemon.
            </p>
          </div>
          <div data-onboarding-target="connect-machine" className="w-fit">
            <Button data-testid={tid.machinePairOpen} onClick={openPair}>
              Connect a machine
            </Button>
          </div>
        </header>
        <div className="flex flex-col gap-3">
          {machines.map((m) => (
            <MachineCard
              key={m.id}
              machine={m}
              onDelete={() => setConfirmDelete(m)}
              onReconnect={() => openReconnect(m)}
              onUpdate={
                canUpdateMachine(m, latestVersion, controllerMode)
                  ? () => setConfirmUpdate(m)
                  : undefined
              }
            />
          ))}
        </div>
      </div>
      <PairMachineSheet
        open={pairOpen}
        onOpenChange={closePair}
        pendingTokenId={pendingTokenId}
        setPendingTokenId={handleSetPendingTokenId}
        connectedHostname={connectedHostname}
        mode={pairMode}
      />
      <MachineUpdateDialog
        machine={confirmUpdate}
        onOpenChange={(open) => !open && setConfirmUpdate(null)}
        onConfirm={onConfirmUpdate}
      />
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {botsToDelete.length > 0
                ? `Can't delete ${confirmDelete?.hostname || "machine"}`
                : `Delete ${confirmDelete?.hostname || "machine"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {botsToDelete.length > 0 ? (
                <>
                  This machine still has{" "}
                  {botsToDelete.length === 1
                    ? `a bot ("${botsToDelete[0].name}")`
                    : `${botsToDelete.length} bots (${botsToDelete
                      .map((b) => b.name)
                      .join(", ")})`}{" "}
                  bound to it. Delete {botsToDelete.length === 1 ? "it " : "them "} from the
                  Bots page first — machines can&apos;t be deleted while they still have
                  bots on them.
                </>
              ) : (
                "The daemon will be disconnected immediately and the pairing key revoked."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {botsToDelete.length > 0 ? (
              <>
                <AlertDialogCancel>Close</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const machineId = confirmDelete?.id
                    setConfirmDelete(null)
                    useCommunityStore.getState().uiHandlers.navigatePath?.(
                      machineId
                        ? `/c/me/bots?machineId=${machineId}`
                        : "/c/me/bots"
                    )
                  }}
                >
                  Manage bots
                </AlertDialogAction>
              </>
            ) : (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onConfirmDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
