"use client"

import { MachineList } from "@/components/community/machines/machine-list"
import { OnboardingSelectDialogPreview } from "@/components/community/onboarding/onboarding-select-dialog.preview"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useUiHandlers } from "@/stores/community"
import { useSearchParams } from "next/navigation"

export default function MeMachinesPage() {
  const bp = useBreakpoint()
  const uiHandlers = useUiHandlers()
  const searchParams = useSearchParams()
  const onboardingPreview = searchParams.get("onboarding-preview")
  const showOnboardingPreview =
    process.env.NODE_ENV !== "production"
    && (
      onboardingPreview === "1"
      || onboardingPreview === "online"
      || onboardingPreview === "setting-up"
    )
  return (
    <>
      <MachineList
        onBack={bp === "mobile" ? () => uiHandlers.goBackMobile?.() : undefined}
      />
      {showOnboardingPreview ? (
        <OnboardingSelectDialogPreview
          simulateOnlineMachine={onboardingPreview === "online"}
          showSettingUp={onboardingPreview === "setting-up"}
        />
      ) : null}
    </>
  )
}
