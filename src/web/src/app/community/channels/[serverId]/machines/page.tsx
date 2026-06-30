"use client"

import { useParams, notFound } from "next/navigation"
import { MachineList } from "@/components/community/machines/machine-list"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { useCommunity } from "@/contexts/community/context"

export default function MachinesPage() {
  const params = useParams<{ serverId: string }>()
  const serverId = decodeURIComponent(params.serverId)
  const bp = useBreakpoint()
  const ctx = useCommunity()
  if (serverId !== "@me") {
    notFound()
  }
  return <MachineList onBack={bp === "mobile" ? () => ctx.goBackMobile() : undefined} />
}
