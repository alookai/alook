"use client"

import { MachineList } from "@/components/community/machines/machine-list"
import { OnboardingSelectDialogPreview } from "@/components/community/onboarding/onboarding-select-dialog.preview"
import { useUiHandlers } from "@/stores/community"
import { useCommunityModuleLocation } from "@/contexts/community/module-route"

export default function MeMachinesPage() {
  const uiHandlers = useUiHandlers()
  const { searchParams, routeCommitted } = useCommunityModuleLocation()
  const onboardingPreview = searchParams.get("onboarding-preview")
  const showOnboardingPreview =
    routeCommitted && process.env.NODE_ENV !== "production"
    && (
      onboardingPreview === "1"
      || onboardingPreview === "online"
      || onboardingPreview === "setting-up"
    )
  return (
    <>
      <MachineList
        onBack={() => uiHandlers.goBackMobile?.()}
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
