"use client"

import { MachineList } from "@/components/community/machines/machine-list"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useUiHandlers } from "@/stores/community"

export default function MeMachinesPage() {
  const bp = useBreakpoint()
  const uiHandlers = useUiHandlers()
  return (
    <MachineList
      onBack={bp === "mobile" ? () => uiHandlers.goBackMobile?.() : undefined}
    />
  )
}
