"use client"

import { useCommunityServerRoute } from "@/components/community/shell/community-route-context"
import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"

export default function ServerSettingsRedirect() {
  const { serverId } = useCommunityServerRoute()
  const router = useRouter()
  const searchParams = useSearchParams()
  useEffect(() => {
    const nextSearchParams = new URLSearchParams(searchParams.toString())
    nextSearchParams.set("settings", "1")
    router.replace(`/c/channels/${encodeURIComponent(serverId)}?${nextSearchParams.toString()}`)
  }, [serverId, router, searchParams])
  return null
}
