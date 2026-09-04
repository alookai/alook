"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import {
  advanceCommunityOnboarding,
  completeCommunityOnboarding,
  consumeQueuedCommunityOnboarding,
  startCommunityOnboarding,
  useCommunityOnboarding,
} from "@/lib/community-onboarding"
import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import {
  ONBOARDING_HARNESSES,
  ONBOARDING_IDENTITIES,
} from "./onboarding-form-options"
import {
  initializeCommunityOnboarding,
  type OnboardingInitializationCheckpoint,
  type OnboardingInitializationResult,
  type OnboardingInitializationStep,
} from "./initialize-community-onboarding"
import { OnboardingSelectDialog } from "./onboarding-select-dialog"
import { OnboardingStatusDialog } from "./onboarding-status-dialog"

function harnessLabel(value?: string) {
  return ONBOARDING_HARNESSES.find((option) => option.value === value)?.label ?? "your agent harness"
}

export function CommunityOnboardingForm() {
  const router = useRouter()
  const state = useCommunityOnboarding()
  const [harness, setHarness] = useState("")
  const [identity, setIdentity] = useState("")
  const [customIdentity, setCustomIdentity] = useState("")
  const [initializationStatus, setInitializationStatus] = useState<
    "idle" | "loading" | "error" | "success"
  >("idle")
  const [initializationStep, setInitializationStep] = useState<OnboardingInitializationStep>(
    "creating-agents",
  )
  const [initializationError, setInitializationError] = useState("")
  const [initializationResult, setInitializationResult] =
    useState<OnboardingInitializationResult | null>(null)
  const checkpointRef = useRef<OnboardingInitializationCheckpoint>({})
  const runningRef = useRef(false)
  useEffect(() => {
    if (!state && consumeQueuedCommunityOnboarding()) startCommunityOnboarding()
  }, [state])

  const runInitialization = useCallback(async () => {
    if (
      runningRef.current ||
      state?.stage !== "initializing" ||
      !state.machineId ||
      !state.harness ||
      !state.identity
    ) return

    runningRef.current = true
    setInitializationStatus("loading")
    setInitializationError("")
    try {
      const result = await initializeCommunityOnboarding({
        machineId: state.machineId,
        runtime: state.harness,
        identity: state.identity,
        checkpoint: checkpointRef.current,
        onCheckpoint: (checkpoint) => {
          checkpointRef.current = checkpoint
        },
        onProgress: setInitializationStep,
      })
      setInitializationResult(result)
      setInitializationStatus("success")
    } catch (error) {
      setInitializationError(
        error instanceof Error && error.message
          ? error.message
          : "We couldn’t finish setting up your room.",
      )
      setInitializationStatus("error")
    } finally {
      runningRef.current = false
    }
  }, [state])

  useEffect(() => {
    if (state?.stage === "initializing" && initializationStatus === "idle") {
      void runInitialization()
    }
  }, [initializationStatus, runInitialization, state?.stage])

  if (!state) return null

  if (state.stage === "harness") {
    return (
      <OnboardingSelectDialog
        open
        onOpenChange={() => undefined}
        step={{ current: 1, total: 3 }}
        stepLabel="Your agent"
        title="Which agent do you already use?"
        description="Start with the setup you know. We’ll bring its agents into a shared room."
        options={[...ONBOARDING_HARNESSES]}
        value={harness}
        onValueChange={setHarness}
        submitLabel="Continue"
        onSubmit={(value) => {
          advanceCommunityOnboarding("harness", "machine", { harness: value })
        }}
      />
    )
  }

  if (state.stage === "machine") {
    return (
      <OnboardingMachineDialog
        open
        harness={state.harness ?? ""}
        harnessLabel={harnessLabel(state.harness)}
        onConnected={(machineId) => {
          advanceCommunityOnboarding("machine", "identity", { machineId })
        }}
      />
    )
  }

  if (state.stage === "identity") {
    return (
      <OnboardingSelectDialog
        open
        onOpenChange={() => undefined}
        step={{ current: 3, total: 3 }}
        stepLabel="About you"
        title="Which best describes you?"
        description="We’ll tailor your first room to how you work."
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
          advanceCommunityOnboarding("identity", "initializing", {
            identity: value,
          })
        }}
      />
    )
  }

  if (state.stage === "initializing") {
    const progressDetail: Record<OnboardingInitializationStep, string> = {
      "creating-agents": "Creating Guide and Builder on your connected machine…",
      "creating-room": "Creating a room for your first goal…",
      "inviting-agents": "Inviting both agents and opening Guide’s private room…",
      "preparing-welcome": "Sending the first collaboration prompts…",
    }
    return (
      <OnboardingStatusDialog
        status={initializationStatus === "idle" ? "loading" : initializationStatus}
        detail={
          initializationStatus === "error"
            ? initializationError
            : initializationStatus === "success"
              ? "Both agents have joined and received your first collaboration brief."
              : progressDetail[initializationStep]
        }
        onRetry={() => void runInitialization()}
        onContinue={() => {
          if (!initializationResult) return
          const destination = `/c/channels/${initializationResult.serverId}/${initializationResult.publicChannelId}`
          completeCommunityOnboarding()
          router.push(destination)
        }}
      />
    )
  }

  return null
}
