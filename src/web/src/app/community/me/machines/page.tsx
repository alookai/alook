"use client"

import { MachineList } from "@/components/community/machines/machine-list"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCommunity } from "@/contexts/community/context"

export default function MeMachinesPage() {
  const bp = useBreakpoint()
  const ctx = useCommunity()
  return <MachineList onBack={bp === "mobile" ? () => ctx.goBackMobile() : undefined} />
}
