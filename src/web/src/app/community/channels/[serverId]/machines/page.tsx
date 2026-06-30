"use client"

import { useParams, notFound } from "next/navigation"
import { MachineList } from "@/components/community/machines/machine-list"

export default function MachinesPage() {
  const params = useParams<{ serverId: string }>()
  const serverId = decodeURIComponent(params.serverId)
  if (serverId !== "@me") {
    notFound()
  }
  return <MachineList />
}
