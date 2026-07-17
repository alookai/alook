"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

export default function CommunityIndex() {
  const router = useRouter()
  useEffect(() => { router.replace("/c/me") }, [router])
  return null
}
