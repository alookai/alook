"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ChevronLeft, Monitor } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import type { CommunityMachineSummary } from "@alook/shared"
import { Button } from "@/components/ui/button"
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
import { apiFetch } from "@/lib/api/client"
import { MachineCard } from "./machine-card"
import { PairMachineSheet, type PairMachineSheetMode } from "./pair-machine-sheet"
import { useMachines, type MachinesResponse } from "@/hooks/community/use-machines"
import { useBots } from "@/hooks/community/use-bots"
import { useCommunityStore, usePendingMachineTokenId } from "@/stores/community"
import { communityKeys } from "@/lib/query-keys"

export function MachineList({ onBack }: { onBack?: () => void } = {}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { machines, isLoading: machinesLoading } = useMachines()
  const { bots } = useBots()
  const pendingMachineTokenId = usePendingMachineTokenId()
  const [pairOpen, setPairOpen] = useState(false)
  const [pairMode, setPairMode] = useState<PairMachineSheetMode>({ kind: "pair" })
  const [pendingTokenId, setPendingTokenId] = useState<string | null>(null)
  const [connectedHostname, setConnectedHostname] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<CommunityMachineSummary | null>(null)

  // When the WS layer announces a machine for our pending token, flip the sheet.
  useEffect(() => {
    if (!pendingTokenId) return
    const justConnected = machines.find(
      (m) =>
        m.lastSeenAt &&
        m.status === "online" &&
        pendingMachineTokenId === pendingTokenId
    )
    if (justConnected && !connectedHostname) {
      setConnectedHostname(justConnected.hostname || "machine")
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
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-22 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      </div>
    )
  }

  if (machines.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-secondary text-muted-foreground">
            <Monitor className="size-6" />
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">No machines yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Connect your computer to keep your agent always-on. Generate a key,
              run the daemon, and the machine shows up here.
            </p>
          </div>
          <Button onClick={openPair}>Connect a machine</Button>
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
          <Button onClick={openPair}>Connect a machine</Button>
        </header>
        <div className="flex flex-col gap-3">
          {machines.map((m) => (
            <MachineCard
              key={m.id}
              machine={m}
              onDelete={() => setConfirmDelete(m)}
              onReconnect={() => openReconnect(m)}
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
                    router.push(
                      machineId
                        ? `/community/me/bots?machineId=${machineId}`
                        : "/community/me/bots"
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
