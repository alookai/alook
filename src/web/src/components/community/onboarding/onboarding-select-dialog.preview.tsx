"use client"

import { useEffect, useState } from "react"

import { skipCommunityOnboarding } from "@/lib/community-onboarding"
import { tid } from "@/lib/community/testids"
import { ONBOARDING_HARNESSES, ONBOARDING_IDENTITIES } from "./onboarding-form-options"
import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import { OnboardingSelectDialog } from "./onboarding-select-dialog"

export function OnboardingSelectDialogPreview({
  simulateOnlineMachine = false,
}: {
  simulateOnlineMachine?: boolean
}) {
  const [value, setValue] = useState("")
  const [customIdentity, setCustomIdentity] = useState("")
  const [harness, setHarness] = useState("")
  const [mode, setMode] = useState<"harness" | "machine" | "identity">("harness")
  const isIdentity = mode === "identity"

  useEffect(() => {
    skipCommunityOnboarding()
    return () => {
      skipCommunityOnboarding()
    }
  }, [])

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
        if (isIdentity) return
        setHarness(submittedValue)
        setMode("machine")
        setValue("")
      }}
    />
  )
}
