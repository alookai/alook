"use client"
import { useCommunityRuntime } from "@/stores/community/runtime"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect } from "react"

import { skipCommunityOnboarding } from "@/lib/community-onboarding"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { tid } from "@/lib/community/testids"
import { ONBOARDING_HARNESSES, ONBOARDING_IDENTITIES } from "./onboarding-form-options"
import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import { OnboardingSelectDialog } from "./onboarding-select-dialog"
import { OnboardingStatusDialog } from "./onboarding-status-dialog"
import {
  ONBOARDING_INITIALIZATION_STEPS,
  type OnboardingInitializationCheckpoint,
  type OnboardingInitializationStep,
} from "./initialize-community-onboarding"

const PREVIEW_CHECKPOINT: OnboardingInitializationCheckpoint = {
  bots: [
    {
      key: "lead",
      id: "preview-bot-a",
    },
    {
      key: "doer",
      id: "preview-bot-b",
    },
    {
      key: "reviewer",
      id: "preview-bot-c",
    },
  ],
  serverId: "preview-server",
  requestedServerName: "Gustavo-work-room",
}

const PREVIEW_PROFILES = new Map([
  ["preview-bot-a", { id: "preview-bot-a", name: "Lin", avatar: "avatar:beam:preview-bot-a", avatarVersion: 0 }],
  ["preview-bot-b", { id: "preview-bot-b", name: "Kit", avatar: "avatar:beam:preview-bot-b", avatarVersion: 0 }],
  ["preview-bot-c", { id: "preview-bot-c", name: "Moss", avatar: "avatar:beam:preview-bot-c", avatarVersion: 0 }],
])

export function OnboardingSelectDialogPreview({
  simulateOnlineMachine = false,
  showSettingUp = false,
}: {
  simulateOnlineMachine?: boolean
  showSettingUp?: boolean
}) {
  const communityRuntime = useCommunityRuntime()
  const [value, setValue] = useAtom(useCreateAtom(""))
  const [customIdentity, setCustomIdentity] = useAtom(useCreateAtom(""))
  const [harness, setHarness] = useAtom(useCreateAtom(""))
  const [mode, setMode] = useAtom(useCreateAtom<"harness" | "machine" | "identity" | "status">("harness"))
  const [initializationStep, setInitializationStep] = useAtom(useCreateAtom<OnboardingInitializationStep>(
    "creating-bots",
  ))
  const isIdentity = mode === "identity"

  useEffect(() => {
    skipCommunityOnboarding(communityRuntime)
    return () => {
      skipCommunityOnboarding(communityRuntime)
    }
  }, [communityRuntime])

  useEffect(() => {
    if (!showSettingUp && mode !== "status") return

    const currentIndex = ONBOARDING_INITIALIZATION_STEPS.indexOf(initializationStep)
    if (currentIndex === ONBOARDING_INITIALIZATION_STEPS.length - 1) return

    const timer = window.setTimeout(() => {
      setInitializationStep(ONBOARDING_INITIALIZATION_STEPS[currentIndex + 1])
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [initializationStep, mode, setInitializationStep, showSettingUp])

  if (showSettingUp || mode === "status") {
    return (
      <CommunityPreviewProfileOwner profiles={PREVIEW_PROFILES}><OnboardingStatusDialog
        status="loading"
        currentStep={initializationStep}
        checkpoint={PREVIEW_CHECKPOINT}
        detail="Follow along as your room comes together."
        onRetry={() => undefined}
        onContinue={() => undefined}
      /></CommunityPreviewProfileOwner>
    )
  }

  if (mode === "machine") {
    return (
      <OnboardingMachineDialog
        open
        harness={harness}
        harnessLabel={
          ONBOARDING_HARNESSES.find((option) => option.value === harness)?.label
            ?? "your harness"
        }
        {...(simulateOnlineMachine
          ? {
              previewConnectedMachine: {
                id: "preview-machine",
                hostname: "QA preview machine",
              },
            }
          : {
              previewCommand: "pnpm daemon start --machine-key preview-machine-key",
            })}
        onConnected={() => {
          setMode("identity")
          setValue("")
        }}
        onChooseAnotherHarness={() => {
          setHarness("")
          setValue("")
          setMode("harness")
        }}
        onManageMachines={() => {
          setHarness("")
          setValue("")
          setMode("harness")
        }}
      />
    )
  }

  return (
    <OnboardingSelectDialog
      open
      onOpenChange={() => undefined}
      step={{ current: isIdentity ? 3 : 1, total: 3 }}
      stepLabel={isIdentity ? "About you" : "Your harness"}
      title={isIdentity ? "Which best describes you?" : "Which harness do you already use?"}
      description={
        isIdentity
          ? "We’ll shape the room around your work."
          : "Pick the setup that already runs your bots."
      }
      options={isIdentity ? [...ONBOARDING_IDENTITIES] : [...ONBOARDING_HARNESSES]}
      value={value}
      onValueChange={setValue}
      {...(isIdentity
        ? {
            customOption: {
              value: "custom",
              label: "Something else",
              placeholder: "Your role",
            },
            customValue: customIdentity,
            onCustomValueChange: setCustomIdentity,
          }
        : {})}
      submitLabel={isIdentity ? "Finish setup" : "Continue"}
      testId={isIdentity ? tid.onboardingIdentityDialog : tid.onboardingHarnessDialog}
      optionTestId={isIdentity ? tid.onboardingIdentityOption : tid.onboardingHarnessOption}
      onSubmit={(submittedValue) => {
        if (isIdentity) {
          setMode("status")
          return
        }
        setHarness(submittedValue)
        setMode("machine")
        setValue("")
      }}
    />
  )
}
