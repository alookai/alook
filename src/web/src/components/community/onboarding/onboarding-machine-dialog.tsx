"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { isPresenceOnline } from "@alook/shared"
import { toast } from "sonner"

import {
  buildPairCommand,
  PairMachineSteps,
} from "@/components/community/machines/pair-machine-sheet"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useMachines } from "@/hooks/community/use-machines"
import { apiFetch } from "@/lib/api/client"

export function OnboardingMachineDialog({
  open,
  harness,
  harnessLabel,
  onConnected,
  previewConnectedMachine,
}: {
  open: boolean
  harness: string
  harnessLabel: string
  onConnected: (machineId: string) => void
  previewConnectedMachine?: { id: string; hostname: string }
}) {
  const { machines, isSuccess, refetch } = useMachines()
  const connectedMachine = useMemo(
    () => machines.find((machine) => isPresenceOnline(machine.status)),
    [machines],
  )
  const onlineMachine = useMemo(
    () => machines.find((machine) =>
      isPresenceOnline(machine.status) &&
      machine.availableRuntimes.some((runtime) => runtime.id === harness && runtime.status !== "unhealthy")
    ),
    [harness, machines],
  )
  const [tokenId, setTokenId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const generateCommand = useCallback(async () => {
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await apiFetch<{ tokenId: string; expiresAt: string }>(
        "/api/community/machines/pair",
        { method: "POST" },
      )
      setTokenId(result.tokenId)
    } catch {
      setGenerateError("Couldn’t prepare the command. Try again.")
    } finally {
      setGenerating(false)
    }
  }, [])

  useEffect(() => {
    if (
      !open ||
      !isSuccess ||
      onlineMachine ||
      previewConnectedMachine ||
      tokenId ||
      generating ||
      generateError
    ) return
    void generateCommand()
  }, [
    generateCommand,
    generateError,
    generating,
    isSuccess,
    onlineMachine,
    open,
    previewConnectedMachine,
    tokenId,
  ])

  useEffect(() => {
    if (!open || !isSuccess || onlineMachine || previewConnectedMachine) return
    const timer = window.setInterval(() => {
      void refetch()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [isSuccess, onlineMachine, open, previewConnectedMachine, refetch])

  const command = tokenId ? buildPairCommand(tokenId) : ""
  const displayedCommand = previewConnectedMachine
    ? "npx --yes @alook/daemon@latest daemon start --machine-key preview-machine-key"
    : command
  const copyCommand = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      toast.success("Command copied")
    } catch {
      toast.error("Copy failed")
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 thin-scrollbar sm:max-w-lg"
      >
        <DialogHeader className="gap-2 px-4 pt-4 pb-3 sm:px-6 sm:pt-6 sm:pb-4">
          <div className="grid grid-cols-3 gap-1" aria-label="Step 2 of 3">
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                className={step <= 2 ? "h-1 rounded-full bg-primary" : "h-1 rounded-full bg-muted"}
              />
            ))}
          </div>
          <p className="font-mono text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
            Your machine · 2 of 3
          </p>
          <DialogTitle className="text-lg leading-snug font-semibold">
            Connect the computer that runs {harnessLabel}
          </DialogTitle>
          <DialogDescription className="max-w-[52ch] leading-relaxed">
            Run this once in Terminal. This page will unlock as soon as Alook sees it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
          <PairMachineSteps
            command={displayedCommand}
            generating={
              !previewConnectedMachine
              && (!isSuccess || generating || (!command && !generateError))
            }
            generationError={generateError}
            onRetry={() => void generateCommand()}
            onCopy={() => void copyCommand()}
            connectedHostname={
              previewConnectedMachine?.hostname
                ?? (onlineMachine ? onlineMachine.hostname || "Your machine" : null)
            }
            headingAs="div"
          />

          {!previewConnectedMachine && !onlineMachine && connectedMachine ? (
            <p role="status" className="text-sm text-muted-foreground">
              {harnessLabel} isn’t available on {connectedMachine.hostname || "this machine"} yet.
            </p>
          ) : null}
        </div>

        <DialogFooter className="m-0 rounded-b-xl bg-popover px-4 py-3 sm:px-6 sm:py-4">
          <Button
            type="button"
            className="h-11 w-full sm:h-9 sm:w-auto"
            disabled={!previewConnectedMachine && !onlineMachine}
            onClick={() => {
              const machineId = previewConnectedMachine?.id ?? onlineMachine?.id
              if (machineId) onConnected(machineId)
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
