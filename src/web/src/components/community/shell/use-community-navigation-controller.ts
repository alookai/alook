"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  commitLatestNavigationIntent,
  createNavigationIntentGate,
  supersedeNavigationIntent,
} from "@/lib/community/navigation-intent"
import {
  isPublishedNonStructuralCommit,
  isStructuralFrameCommit,
  normalizeCommunityHref,
  type CommunityCommittedFrame,
} from "@/lib/community/community-route"
import type { ShellRouter } from "./shell-frame-types"

export type CommunityNavigationController = {
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
  push: (href: string) => void
  pushImmediate: (href: string) => void
  replace: (href: string) => void
  prefetch: (href: string) => void
  resolveAndPush: (resolve: () => Promise<string>) => Promise<boolean>
  cancelPendingNavigation: () => void
}

export function useCommunityNavigationController(
  committedFrame: CommunityCommittedFrame,
): CommunityNavigationController {
  const router = useRouter() as ShellRouter
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const publishedHref = search ? `${pathname}?${search}` : pathname
  const gateRef = useRef(createNavigationIntentGate())
  const pendingBaselineRevisionRef = useRef(committedFrame.revision)
  const pendingBaselineLeafRef = useRef(committedFrame.leafKey)
  const [navigationPending, setNavigationPending] = useState(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(false)
    setPendingHref(null)
  }, [])

  useEffect(() => {
    if (pendingHref === null) return
    const target = normalizeCommunityHref(pendingHref)
    const settled = target.leafKey === pendingBaselineLeafRef.current
      ? isPublishedNonStructuralCommit(committedFrame, publishedHref, pendingHref)
      : isStructuralFrameCommit({
          committedFrame,
          targetHref: pendingHref,
          baselineRevision: pendingBaselineRevisionRef.current,
        })
    if (!settled) return
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(false)
    setPendingHref(null)
  }, [committedFrame, pendingHref, publishedHref])

  useEffect(() => {
    if (typeof window === "undefined") return
    const onPopState = () => cancelPendingNavigation()
    window.addEventListener("popstate", onPopState)
    return () => {
      window.removeEventListener("popstate", onPopState)
    }
  }, [cancelPendingNavigation])

  const push = useCallback((href: string) => {
    if (href === publishedHref) return
    supersedeNavigationIntent(gateRef.current)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    setNavigationPending(true)
    setPendingHref(href)
    router.push(href)
  }, [committedFrame.leafKey, committedFrame.revision, publishedHref, router])

  const pushImmediate = useCallback((href: string) => {
    if (href === publishedHref) return
    supersedeNavigationIntent(gateRef.current)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    // Inbox promises a target checkpoint on the next paint. Publish it before
    // Next starts the RSC transition instead of leaving it in the event batch.
    flushSync(() => {
      setNavigationPending(true)
      setPendingHref(href)
    })
    router.push(href)
  }, [committedFrame.leafKey, committedFrame.revision, publishedHref, router])

  const replace = useCallback((href: string) => {
    if (href === publishedHref) return
    supersedeNavigationIntent(gateRef.current)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    setNavigationPending(true)
    setPendingHref(href)
    router.replace(href)
  }, [committedFrame.leafKey, committedFrame.revision, publishedHref, router])

  const resolveAndPush = useCallback(async (resolve: () => Promise<string>) => {
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    setNavigationPending(true)
    setPendingHref(null)
    try {
      return await commitLatestNavigationIntent(gateRef.current, resolve, (href) => {
        if (href === publishedHref) {
          setNavigationPending(false)
          setPendingHref(null)
          return
        }
        setPendingHref(href)
        router.push(href)
      })
    } catch (error) {
      setNavigationPending(false)
      setPendingHref(null)
      throw error
    }
  }, [committedFrame.leafKey, committedFrame.revision, publishedHref, router])

  return {
    publishedHref,
    navigationPending,
    pendingHref,
    push,
    pushImmediate,
    replace,
    prefetch: router.prefetch,
    resolveAndPush,
    cancelPendingNavigation,
  }
}
