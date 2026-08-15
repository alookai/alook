"use client"

import { useEffect } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"

export default function ServerSettingsRedirect() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  useEffect(() => {
    const nextSearchParams = new URLSearchParams(searchParams.toString())
    nextSearchParams.set("settings", "1")
    router.replace(`/c/channels/${params.serverId}?${nextSearchParams.toString()}`)
  }, [params.serverId, router, searchParams])
  return null
}
