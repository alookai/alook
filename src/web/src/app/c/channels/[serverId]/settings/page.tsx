"use client"

import { useEffect } from "react"
import { useParams, useRouter } from "next/navigation"

export default function ServerSettingsRedirect() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  useEffect(() => {
    router.replace(`/c/channels/${params.serverId}?settings=1`)
  }, [params.serverId, router])
  return null
}
