"use client"

import { useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useMemo } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { isPresenceOnline } from "@alook/shared"
import { CircleAlert } from "lucide-react"
import { toast } from "sonner"

import {
  buildPairCommand,
  PairMachineSteps,
} from "@/components/community/machines/pair-machine-sheet"
import { ProviderLogo } from "@/components/provider-logo"
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
import { tid } from "@/lib/community/testids"

export function OnboardingMachineDialog({
  open,
  harness,
  harnessLabel,
  onConnected,
  onChooseAnotherHarness,
  onManageMachines,
  previewConnectedMachine,
  previewCommand,
}: {
  open: boolean
  harness: string
  harnessLabel: string
  onConnected: (machineId: string) => void
  onChooseAnotherHarness: () => void
  onManageMachines: () => void
  previewConnectedMachine?: { id: string; hostname: string }
  previewCommand?: string
}) {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  const source = useCommunityViewSource(`onboarding-machine:${harness}`, open)
  const { machines, isSuccess, refetch } = useMachines({
    enabled: open, subscribed: open,
    refetchInterval: (query) => open && !previewConnectedMachine && !previewCommand && !query.state.data?.machines.some((machine) => isPresenceOnline(machine.status) && machine.availableRuntimes.some((runtime) => runtime.id === harness && runtime.status !== "unhealthy")) ? 2000 : false,
  })
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
  const autoMint = useCreateAtom<AbortSignal | null>(null)
  const autoAdvance = useCreateAtom<AbortSignal | null>(null)
  const readyMachineId = previewConnectedMachine?.id ?? onlineMachine?.id
  useEffect(() => {
    if (!open) { autoAdvance.set(null); return }
    if (!readyMachineId || autoAdvance.get() === source.signal) return
    source.capture()()
    autoAdvance.set(source.signal)
    onConnected(readyMachineId)
  }, [open, readyMachineId, source, onConnected, autoAdvance])
  const generation = useMutation({ meta: { observabilityAction: "machine.pair.generate" },
    mutationKey: ["community", "onboarding-machine-pair", harness], gcTime: 0,
    mutationFn: async ({ token, assert }: { token: ReturnType<typeof origin.begin>["token"]; assert: ReturnType<typeof source.capture> }) => {
      assert()
      const result = await origin.request<{ tokenId: string; expiresAt: string }>(token, "/api/community/machines/pair", { method: "POST", signal: assert.signal, assertActive: assert })
      assert()
      return result
    },
  })
  const currentGeneration = generation.variables?.assert.signal === source.signal
  const generating = currentGeneration && generation.isPending
  const tokenId = currentGeneration ? generation.data?.tokenId : undefined
  const error = currentGeneration ? generation.error : null
  const machineLimitReached = error instanceof Error && error.message === "MACHINE_LIMIT_REACHED"
  const generateError = error && !machineLimitReached && !(error instanceof DOMException && error.name === "AbortError") ? "Couldn’t prepare the command. Try again." : null
  const mutateGeneration = generation.mutateAsync
  const generateCommand = useCallback(async () => {
    if (generating || queryClient.getMutationCache().find({ mutationKey: ["community", "onboarding-machine-pair", harness], status: "pending", predicate: (mutation) => (mutation.state.variables as { assert?: { signal: AbortSignal } } | undefined)?.assert?.signal === source.signal })) return
    const token = origin.begin().token, assert = source.capture()
    assert()
    try { await mutateGeneration({ token, assert }) }
    catch (error) {
      try { assert() } catch { return }
      if (error instanceof Error && error.message === "MACHINE_LIMIT_REACHED") void refetch({ cancelRefetch: false })
    }
  }, [generating, queryClient, harness, origin, source, mutateGeneration, refetch])

  useEffect(() => {
    if (!open) { autoMint.set(null); return }
    if (
      autoMint.get() === source.signal ||
      !isSuccess ||
      onlineMachine ||
      previewConnectedMachine ||
      previewCommand ||
      tokenId ||
      generating ||
      machineLimitReached ||
      generateError
    ) return
    autoMint.set(source.signal)
    void generateCommand()
  }, [
    generateCommand,
    generateError,
    generating,
    isSuccess,
    machineLimitReached,
    onlineMachine,
    open,
    previewConnectedMachine,
    previewCommand,
    tokenId,
    source.signal,
    autoMint,
  ])

  const command = tokenId ? buildPairCommand(tokenId) : ""
  const displayedCommand = previewConnectedMachine
    ? "npx --yes @alook/daemon@latest daemon start --machine-key preview-machine-key"
    : previewCommand ?? command
  const copyCommand = async () => {
    if (!displayedCommand) return
    const assert = source.capture()
    assert()
    try {
      await navigator.clipboard.writeText(displayedCommand)
      assert()
      toast.success("Command copied")
    } catch {
      try { assert() } catch { return }
      toast.error("Copy failed")
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        data-testid={tid.onboardingMachineDialog}
        showCloseButton={false}
        overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto border-0 p-0 shadow-(--e2) ring-0 thin-scrollbar sm:max-w-lg"
      >
        <DialogHeader className="gap-4 px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
          <div className="grid grid-cols-3 gap-1" aria-label="Step 2 of 3">
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                className={step <= 2 ? "h-1 rounded-full bg-primary" : "h-1 rounded-full bg-muted"}
              />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <DialogTitle className="flex flex-wrap items-center gap-x-2 text-2xl leading-tight font-semibold tracking-tight">
              <span>Connect your</span>
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <ProviderLogo provider={harness} className="size-5" />
                {harnessLabel}
              </span>
              <span>machine</span>
            </DialogTitle>
            <DialogDescription className="max-w-[52ch] leading-relaxed">
              Run one command. We’ll continue when it’s online.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
          {machineLimitReached && !onlineMachine ? (
            <section
              role="alert"
              className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4"
            >
              <div className="flex items-start gap-3">
                <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-sm font-medium text-foreground">Machine limit reached</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Your plan can’t connect another machine. Choose a harness already available on an online machine, or manage your machines and restart setup.
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={onChooseAnotherHarness}>
                  Choose another harness
                </Button>
                <Button type="button" onClick={onManageMachines}>
                  Manage machines
                </Button>
              </div>
            </section>
          ) : (
            <PairMachineSteps
              command={displayedCommand}
              generating={
                !previewConnectedMachine
                && !previewCommand
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
              concise
            />
          )}

          {!machineLimitReached && !previewConnectedMachine && !onlineMachine && connectedMachine ? (
            <p role="status" className="text-sm text-muted-foreground">
              {harnessLabel} isn’t available on {connectedMachine.hostname || "this machine"} yet.
            </p>
          ) : null}
        </div>

        <DialogFooter className="m-0 rounded-b-xl border-0 bg-transparent px-4 py-4 sm:px-6">
          <Button
            type="button"
            className="h-11 w-full sm:h-9 sm:w-auto"
            disabled={!previewConnectedMachine && !onlineMachine}
            onClick={() => {
              source.capture()()
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
