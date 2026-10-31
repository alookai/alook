"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect } from "react"
import { QueryObserver, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { serverProjectedQueryFn } from "@/hooks/community/use-servers"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import { usePathname } from "next/navigation"

import { finishCommunityOnboardingAgentSetup, switchCommunityOnboardingSetup, advanceCommunityOnboarding, completeCommunityOnboarding, recoverCommunityOnboardingHarness, skipCommunityOnboarding, useCommunityOnboarding, readCommunityOnboardingState, updateCommunityOnboardingInitialization } from "@/lib/community-onboarding"

import { Button } from "@/components/ui/button"
import { X } from "lucide-react"
import { Dialog as SetupDialog } from "@base-ui/react/dialog"
import { AppEdgeFade, appBackdropClassName } from "@/components/ui/app-edge-fade"
import { OnboardingSurface } from "./onboarding-surface"
import { OnboardingAgentDialog } from "./onboarding-agent-dialog"
import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import {
  ONBOARDING_HARNESSES,
  ONBOARDING_IDENTITIES,
} from "./onboarding-form-options"
import { beginOnboardingAnalytics } from "@/lib/product-analytics"
import { initializeCommunityOnboarding } from "./initialize-community-onboarding"
import { tid } from "@/lib/community/testids"
import { useCurrentUser } from "@/contexts/community/current-user"
import { OnboardingSelectDialog } from "./onboarding-select-dialog"
import { OnboardingStatusDialog } from "./onboarding-status-dialog"
import { requiresExplicitModel } from "@alook/shared"
import { useMachines } from "@/hooks/community/use-machines"
import { OnboardingModelDialog } from "./onboarding-model-dialog"

function harnessLabel(value?: string) {
  return ONBOARDING_HARNESSES.find((option) => option.value === value)?.label ?? "your harness"
}

function CommunityOnboardingSteps() {
  const communityRuntime = useCommunityRuntime()
  const pathname = usePathname()
  const currentUser = useCurrentUser()
  const state = useCommunityOnboarding()
  const queryClient = useQueryClient(), origin = useCommunityMutationOrigin()
  const journeyIdentity = JSON.stringify([state?.machineId, state?.harness, state?.identity, state?.model])
  const source = useCommunityViewSource(`onboarding:${journeyIdentity}`, state?.stage === "initializing")
  const [harness, setHarness] = useAtom(useCreateAtom(""))
  const [identity, setIdentity] = useAtom(useCreateAtom(""))
  const [customIdentity, setCustomIdentity] = useAtom(useCreateAtom(""))
  const [model, setModel] = useAtom(useCreateAtom<string | null>(null))
  const requiredModel = requiresExplicitModel(state?.harness)
  const totalSteps = requiredModel ? 4 : 3
  const { machines } = useMachines({ enabled: state?.stage === "model" })
  const selectedRuntime = machines.find((machine) => machine.id === state?.machineId)?.availableRuntimes?.find((runtime) => runtime.id === state?.harness)
  useEffect(() => { setModel(null) }, [state?.machineId, state?.harness, setModel])
  const commandKey = ["community", "onboarding-initialization", journeyIdentity] as const
  const pending = useMutationState({ filters: { mutationKey: commandKey, status: "pending" }, select: (mutation) => mutation.mutationId })
  const initialization = useMutation({ meta: { observabilityAction: "community.onboarding.initialize" },
    mutationKey: commandKey,
    scope: { id: JSON.stringify(commandKey) },
    mutationFn: async ({ token, profileSnapshot, assert, input }: ReturnType<typeof origin.begin> & {
      assert: ReturnType<typeof source.capture>
      input: { machineId: string; runtime: string; model?: string | null; identity: string; userName: string; userDiscriminator?: string }
    }) => {
      assert()
      const original = readCommunityOnboardingState(communityRuntime)
      const result = await initializeCommunityOnboarding({
        ...input,
        checkpoint: original?.initialization?.checkpoint,
        onCheckpoint: (checkpoint) => { assert(); updateCommunityOnboardingInitialization(communityRuntime, (current) => ({ ...current, checkpoint })) },
        onProgress: (step) => { assert(); updateCommunityOnboardingInitialization(communityRuntime, (current) => ({ ...current, step })) },
        services: {
          assert,
          request: (path, options) => origin.request(token, path, { ...options, signal: assert.signal, assertActive: assert }),
          publishBot: (bot, requested) => {
            assert()
            writeCommunityProfilePatches([{
              id: bot.id,
              identityAbout: { name: bot.name ?? requested.name, discriminator: bot.discriminator, kind: "bot" },
              avatar: { avatar: bot.image ?? requested.image, avatarVersion: bot.avatarVersion },
            }], origin.registry, { snapshot: profileSnapshot })
          },
          resolveBot: (id) => {
            const profile = origin.registry?.collections.profiles.get(id)
            return profile?.name === undefined ? undefined : { name: profile.name, discriminator: profile.discriminator ?? undefined }
          },
          readChannels: async (serverId) => {
            assert()
            await queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
            assert()
            const options = { queryKey: communityKeys.server(serverId), queryFn: ({ signal }: { signal: AbortSignal }) => serverProjectedQueryFn(queryClient, serverId, signal)(), staleTime: 0 }
            const observer = new QueryObserver(queryClient, { ...options, enabled: false })
            const unsubscribe = observer.subscribe(() => undefined)
            assert.signal.addEventListener("abort", unsubscribe, { once: true })
            try {
              assert()
              await queryClient.query({ ...options, select: undefined })
              assert()
              return [...origin.registry!.collections.channels.values()].filter((channel) => channel.serverId === serverId && !channel.parentChannelId).map(({ id, name, type, categoryId }) => ({ id, name: name ?? "", type, categoryId: categoryId ?? null }))
            } finally { assert.signal.removeEventListener("abort", unsubscribe); unsubscribe() }
          },
        },
      })
      assert()
      updateCommunityOnboardingInitialization(communityRuntime, (current) => ({ ...current, result }))
      await queryClient.invalidateQueries({ queryKey: communityKeys.bots(), exact: true })
      origin.assert(token)
      return result
    },
  })
  const protocol = state?.initialization
  const initializationCheckpoint = protocol?.checkpoint ?? {}
  const initializationStep = protocol?.step ?? "creating-bots"
  const initializationResult = protocol?.result ?? null
  const currentError = initialization.variables?.assert.signal === source.signal ? initialization.error : null
  const initializationError = currentError instanceof Error ? currentError.message : "We couldn’t finish setting up your room."
  const initializationStatus = initializationResult ? "success" : pending.length ? "loading" : currentError && !(currentError instanceof DOMException && currentError.name === "AbortError") ? "error" : "idle"
  useEffect(() => {
    const pendingDestination = protocol?.pendingDestination
    if (!pendingDestination || pathname !== pendingDestination) return
    completeCommunityOnboarding(communityRuntime, pathname)
  }, [pathname, protocol?.pendingDestination, communityRuntime])

  const mutateInitialization = initialization.mutateAsync
  const runInitialization = useCallback(async () => {
    if (
      pending.length ||
      state?.stage !== "initializing" ||
      !state.machineId ||
      !state.harness ||
      !state.identity
    ) return

    const original = origin.begin(), assert = source.capture()
    assert()
    try {
      await mutateInitialization({
        ...original, assert,
        input: { machineId: state.machineId, runtime: state.harness, model: state.model, identity: state.identity, userName: currentUser.name, userDiscriminator: currentUser.discriminator },
      })
    } catch {}
  }, [pending.length, state, origin, source, mutateInitialization, currentUser.name, currentUser.discriminator])

  useEffect(() => {
    if (state?.stage === "initializing" && initializationStatus === "idle") {
      void runInitialization()
    }
  }, [initializationStatus, journeyIdentity, state?.stage, source.signal, runInitialization])

  if (!state) return null

  if (state.stage === "harness") {
    return (
      <OnboardingSelectDialog
        open
        onOpenChange={(open) => { if (!open) skipCommunityOnboarding(communityRuntime) }}
        step={{ current: 1, total: 2 }}
        dismissible
        stepLabel="Your harness"
        title="Which harness do you already use?"
        description="Pick the setup that already runs your bots."
        options={[...ONBOARDING_HARNESSES]}
        value={harness}
        onValueChange={setHarness}
        submitLabel="Continue"
        onSubmit={(value) => {
          advanceCommunityOnboarding(communityRuntime, "harness", "machine", { harness: value, setupMode: "agent" })
        }}
        testId={tid.onboardingHarnessDialog}
        optionTestId={tid.onboardingHarnessOption}
      />
    )
  }

  if (state.stage === "machine" && state.setupMode === "agent") {
    return <OnboardingAgentDialog
      harness={state.harness ?? ""}
      harnessLabel={harnessLabel(state.harness)}
      onConnected={() => finishCommunityOnboardingAgentSetup(communityRuntime)}
      onChooseAgent={() => recoverCommunityOnboardingHarness(communityRuntime)}
      onExit={() => skipCommunityOnboarding(communityRuntime)}
    />
  }

  if (state.stage === "machine") {
    return (
      <OnboardingMachineDialog
        open
        harness={state.harness ?? ""}
        harnessLabel={harnessLabel(state.harness)}
        totalSteps={totalSteps}
        onExit={() => skipCommunityOnboarding(communityRuntime)}
        onConnected={(machineId) => {
          advanceCommunityOnboarding(communityRuntime, "machine", requiredModel ? "model" : "identity", { machineId, model: null })
        }}
        onChooseAnotherHarness={() => {
          setHarness("")
          recoverCommunityOnboardingHarness(communityRuntime)
        }}
        onManageMachines={() => {
          skipCommunityOnboarding(communityRuntime)
        }}
      />
    )
  }

  if (state.stage === "model") {
    return <OnboardingModelDialog onExit={() => skipCommunityOnboarding(communityRuntime)} runtime={selectedRuntime ?? { id: state.harness! }} model={model} onModelChange={setModel} onContinue={() => advanceCommunityOnboarding(communityRuntime, "model", "identity", { model })} />
  }

  if (state.stage === "identity") {
    return (
      <OnboardingSelectDialog
        open
        onOpenChange={(open) => { if (!open) skipCommunityOnboarding(communityRuntime) }}
        step={{ current: totalSteps, total: totalSteps }}
        stepLabel="About you"
        dismissible
        title="Which best describes you?"
        description="We’ll shape the room around your work."
        options={[...ONBOARDING_IDENTITIES]}
        value={identity}
        onValueChange={setIdentity}
        customOption={{
          value: "custom",
          label: "Something else",
          placeholder: "Your role",
        }}
        customValue={customIdentity}
        onCustomValueChange={setCustomIdentity}
        submitLabel="Finish setup"
        onSubmit={(value) => {
          advanceCommunityOnboarding(communityRuntime, "identity", "initializing", {
            identity: value,
          })
        }}
        testId={tid.onboardingIdentityDialog}
        optionTestId={tid.onboardingIdentityOption}
      />
    )
  }

  if (state.stage === "initializing") {
    return (
      <OnboardingStatusDialog
        onExit={() => skipCommunityOnboarding(communityRuntime)}
        totalSteps={totalSteps}
        status={initializationStatus === "idle" ? "loading" : initializationStatus}
        currentStep={initializationStep}
        checkpoint={initializationCheckpoint}
        detail={
          initializationStatus === "error"
            ? initializationError
            : initializationStatus === "success"
              ? `${initializationResult?.bots.length ?? 0} bots are in your room and ready to work.`
              : "Follow along as your room comes together."
        }
        onRetry={() => void runInitialization()}
        onContinue={async () => {
          if (!initializationResult) return
          const destination = `/c/channels/${initializationResult.serverId}/${initializationResult.publicChannelId}`
          const assert = source.capture()
          assert()
          beginOnboardingAnalytics(currentUser.id, initializationResult.serverId)
          if (!communityRuntime.lifecycle.get().active) return
          try { assert() } catch { return }
          const navigate = communityRuntime.ui.get().uiHandlers.navigate
          if (!navigate) return
          updateCommunityOnboardingInitialization(communityRuntime, (current) => ({ ...current, pendingDestination: destination }))
          navigate(initializationResult.serverId, initializationResult.publicChannelId)
        }}
      />
    )
  }

  return null
}

export function CommunityOnboardingForm() {
  const runtime = useCommunityRuntime()
  const state = useCommunityOnboarding()
  if (!state) return null
  const selected = Boolean(state.harness)
  const mode = state.setupMode === "agent" ? "agent" : "manual"
  const switching = selected && ["machine", "model", "identity"].includes(state.stage)
  return <SetupDialog.Root open onOpenChange={(open) => { if (!open) skipCommunityOnboarding(runtime) }}>
    <SetupDialog.Portal>
    <SetupDialog.Backdrop className={`fixed inset-0 z-50 ${appBackdropClassName}`}><AppEdgeFade /></SetupDialog.Backdrop>
    <SetupDialog.Popup aria-label="Set up Alook" data-testid="onboarding-surface" className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col gap-3 text-foreground outline-none">
    <OnboardingSurface>
      <header className="flex shrink-0 items-center justify-between gap-4 px-2">
        <nav aria-label="Setup method" className="flex gap-4">
          {selected ? (["agent", "manual"] as const).map((value) => <button
            key={value} type="button" data-testid={`onboarding-mode-${value}`} aria-pressed={mode === value}
            disabled={!switching} onClick={() => { if (mode !== value) switchCommunityOnboardingSetup(runtime, value) }}
            className={`inline-flex min-h-11 items-center bg-transparent px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed ${mode === value ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          ><span className={`border-b-2 pb-1 ${mode === value ? "border-foreground" : "border-transparent"}`}>{value === "agent" ? "Agent" : "Manual"}</span></button>) : <span className="text-sm text-muted-foreground">Set up Alook</span>}
        </nav>
        <Button type="button" variant="ghost" size="icon" aria-label="Exit setup" title="Exit setup" className="size-11 text-foreground" onClick={() => skipCommunityOnboarding(runtime)}><X aria-hidden className="size-4" /></Button>
      </header>
      <div className="min-h-0 overflow-y-auto thin-scrollbar rounded-xl bg-popover text-popover-foreground shadow-(--e2)">
        <CommunityOnboardingSteps />
      </div>
    </OnboardingSurface>
    </SetupDialog.Popup>
    </SetupDialog.Portal>
  </SetupDialog.Root>
}
