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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { X } from "lucide-react"
import { Dialog as SetupDialog } from "@base-ui/react/dialog"
import { AppEdgeFade, appBackdropClassName } from "@/components/ui/app-edge-fade"
import { StepSlide } from "@/components/ui/step-slide"
import { OnboardingSurface } from "./onboarding-surface"
import { OnboardingAgentDialog } from "./onboarding-agent-dialog"
import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import {
  ONBOARDING_HARNESSES,
  ONBOARDING_IDENTITIES,
  supportsAgentSetup,
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
          publishBot: async (bot, requested) => {
            assert()
            await writeCommunityProfilePatches([{
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
        title="Which harness do you already use?"
        description="Pick the setup that already runs your bots."
        options={[...ONBOARDING_HARNESSES]}
        value={harness}
        onValueChange={setHarness}
        advanceOnSelect
        submitLabel="Continue"
        onSubmit={(value) => {
          advanceCommunityOnboarding(communityRuntime, "harness", "machine", { harness: value, setupMode: supportsAgentSetup(value) ? "agent" : "manual" })
        }}
        testId={tid.onboardingHarnessDialog}
        optionTestId={tid.onboardingHarnessOption}
      />
    )
  }

  if (state.stage === "machine" && state.setupMode === "agent" && supportsAgentSetup(state.harness)) {
    return <OnboardingAgentDialog
      harness={state.harness ?? ""}
      harnessLabel={harnessLabel(state.harness)}
      onConnected={() => finishCommunityOnboardingAgentSetup(communityRuntime)}
      onChooseAgent={() => { setHarness(""); recoverCommunityOnboardingHarness(communityRuntime) }}
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
  const agentSetup = supportsAgentSetup(state.harness)
  const mode = state.setupMode === "agent" && agentSetup ? "agent" : "manual"
  const switching = selected && ["machine", "model", "identity"].includes(state.stage)
  return <SetupDialog.Root open onOpenChange={(_open, details) => details.cancel()}>
    <SetupDialog.Portal>
    <SetupDialog.Backdrop data-slot="onboarding-backdrop" className={`fixed inset-0 z-50 ${appBackdropClassName}`}><AppEdgeFade /></SetupDialog.Backdrop>
    <div className="app-safe-viewport app-safe-overlay-viewport app-safe-portal-viewport pointer-events-none fixed z-50">
    <SetupDialog.Popup aria-label="Set up Alook" data-testid="onboarding-surface" className="pointer-events-auto fixed top-[max(1rem,12%)] left-1/2 z-50 flex max-h-[calc(100%-max(1rem,12%)-1rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-popover text-foreground text-popover-foreground shadow-(--e2) outline-none">
    <OnboardingSurface>
      {/* Title, mode switch and close live inside the card, on its top edge (QA #4). */}
      <header data-slot="onboarding-card-header" className="flex shrink-0 items-center justify-between gap-4 px-4 pt-2 sm:px-6">
        {selected ? <Tabs value={mode} onValueChange={(value) => {
          if (switching && (value === "manual" || (value === "agent" && agentSetup)) && mode !== value) switchCommunityOnboardingSetup(runtime, value)
        }}>
          <TabsList aria-label="Setup method" className="thin-scrollbar">
            {(["agent", "manual"] as const).map((value) => <TabsTrigger key={value} value={value} data-testid={`onboarding-mode-${value}`} disabled={!switching || (value === "agent" && !agentSetup)}>{value === "agent" ? "Agent" : "Manual"}</TabsTrigger>)}
          </TabsList>
        </Tabs> : <span className="text-sm text-muted-foreground">Pick your local agent</span>}
        <Button type="button" variant="ghost" size="icon" aria-label="Exit setup" title="Exit setup" className="size-11 text-foreground" onClick={() => skipCommunityOnboarding(runtime)}><X aria-hidden className="size-4" /></Button>
      </header>
      <div className="min-h-0 overflow-y-auto thin-scrollbar">
        <StepSlide testId="onboarding-step-transition" step={`${state.stage}-${mode}`} order={["harness", "machine", "model", "identity", "initializing"].indexOf(state.stage) * 2 + (mode === "manual" ? 1 : 0)}>
          <CommunityOnboardingSteps />
        </StepSlide>
      </div>
    </OnboardingSurface>
    </SetupDialog.Popup>
    </div>
    </SetupDialog.Portal>
  </SetupDialog.Root>
}
