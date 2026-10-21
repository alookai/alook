"use client"

import { useCommunityServerRoute } from "@/components/community/shell/community-route-context"
import { useEffect } from "react"
import { useCommunityModuleLocation } from "@/contexts/community/module-route"

export default function ServerSettingsRedirect() {
  const { serverId } = useCommunityServerRoute()
  const { router, searchParams } = useCommunityModuleLocation()
  useEffect(() => {
    const nextSearchParams = new URLSearchParams(searchParams.toString())
    nextSearchParams.set("settings", "1")
    router.replace(`/c/channels/${encodeURIComponent(serverId)}?${nextSearchParams.toString()}`)
  }, [serverId, router, searchParams])
  return null
}
