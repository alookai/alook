"use client"

import { useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { removeCommunityParam } from "@/lib/community/community-route"

export function useDmSeqContext({
  dmId,
  historyAllowed,
  navigationAllowed,
  setContextSeq,
}: {
  dmId: string
  historyAllowed: boolean
  navigationAllowed: boolean
  setContextSeq: (seq: number | null) => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const seqParam = searchParams.get("seq")
  const search = searchParams.toString()

  useEffect(() => {
    if (!historyAllowed || !navigationAllowed) {
      setContextSeq(null)
      return
    }
    if (pathname !== `/c/me/${dmId}` || !seqParam) return
    const seq = Number(seqParam)
    if (!Number.isSafeInteger(seq) || seq < 1) return
    setContextSeq(seq)
    const href = `${pathname}${search ? `?${search}` : ""}`
    router.replace(removeCommunityParam(href, "seq"), { scroll: false })
  }, [dmId, historyAllowed, navigationAllowed, pathname, router, search, seqParam, setContextSeq])
}
