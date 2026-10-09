"use client"

import { beginNavigation, navigationNoop } from "@/lib/observability/context"
import { prepareNavigationMetadata } from "@/lib/community/navigation-metadata"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { flushSync } from "react-dom"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
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
import { cancelActiveConversationNavigationProof } from "@/lib/community/conversation-navigation-proof"

export type CommunityNavigationController = {
  captureIntent: () => () => boolean
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
  push: (href: string) => void
  pushImmediate: (href: string) => void
  replace: (href: string) => void
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
  const queryClient = useQueryClient()
  const gateRef = useRef(createNavigationIntentGate())
  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const committedFrameRef = useRef(committedFrame)
  useLayoutEffect(() => { committedFrameRef.current = committedFrame }, [committedFrame])
  const captureIntent = useCallback(() => {
    const revision = gateRef.current.revision
    const frameRevision = committedFrameRef.current.revision
    return () => mountedRef.current && revision === gateRef.current.revision
      && frameRevision === committedFrameRef.current.revision
  }, [])
  const pendingBaselineRevisionRef = useRef(committedFrame.revision)
  const pendingBaselineLeafRef = useRef(committedFrame.leafKey)
  const [navigationPending, setNavigationPending] = useAtom(useCreateAtom(false))
  const [pendingHref, setPendingHref] = useAtom(useCreateAtom<string | null>(null))

  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(gateRef.current)
    cancelActiveConversationNavigationProof(queryClient)
    setNavigationPending(false)
    setPendingHref(null)
  }, [queryClient, setNavigationPending, setPendingHref])

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
  }, [committedFrame, pendingHref, publishedHref, setNavigationPending, setPendingHref])

  useEffect(() => {
    if (typeof window === "undefined") return
    const onPopState = () => cancelPendingNavigation()
    window.addEventListener("popstate", onPopState)
    return () => {
      window.removeEventListener("popstate", onPopState)
    }
  }, [cancelPendingNavigation])

  const push = useCallback((href: string) => {
    if (href === publishedHref && !navigationPending) { navigationNoop(href); return }
    beginNavigation(href)
    void prepareNavigationMetadata(queryClient, href, "foreground")
    supersedeNavigationIntent(gateRef.current)
    cancelActiveConversationNavigationProof(queryClient)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    // Publish the target checkpoint before Next starts the RSC transition.
    // Otherwise React can leave this event-batched behind a suspended push and
    // the committed conversation remains visible while the target is pending.
    flushSync(() => {
      setNavigationPending(true)
      setPendingHref(href)
    })
    router.push(href)
  }, [committedFrame.leafKey, committedFrame.revision, navigationPending, publishedHref, queryClient, router, setNavigationPending, setPendingHref])

  const pushImmediate = useCallback((href: string) => {
    if (href === publishedHref && !navigationPending) { navigationNoop(href); return }
    beginNavigation(href)
    void prepareNavigationMetadata(queryClient, href, "foreground")
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
  }, [committedFrame.leafKey, committedFrame.revision, navigationPending, publishedHref, queryClient, router, setNavigationPending, setPendingHref])

  const replace = useCallback((href: string) => {
    if (href === publishedHref && !navigationPending) { navigationNoop(href); return }
    beginNavigation(href)
    void prepareNavigationMetadata(queryClient, href, "foreground")
    supersedeNavigationIntent(gateRef.current)
    cancelActiveConversationNavigationProof(queryClient)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    setNavigationPending(true)
    setPendingHref(href)
    router.replace(href)
  }, [committedFrame.leafKey, committedFrame.revision, navigationPending, publishedHref, queryClient, router, setNavigationPending, setPendingHref])

  const resolveAndPush = useCallback(async (resolve: () => Promise<string>) => {
    cancelActiveConversationNavigationProof(queryClient)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    setNavigationPending(true)
    setPendingHref(null)
    const operation = commitLatestNavigationIntent(gateRef.current, resolve, (href) => {
        if (href === publishedHref) {
          navigationNoop(href)
          setNavigationPending(false)
          setPendingHref(null)
          return
        }
        beginNavigation(href)
        void prepareNavigationMetadata(queryClient, href, "foreground")
        setPendingHref(href)
        router.push(href)
    })
    const revision = gateRef.current.revision
    try {
      return await operation
    } catch (error) {
      if (gateRef.current.revision === revision) {
        setNavigationPending(false)
        setPendingHref(null)
      }
      throw error
    }
  }, [committedFrame.leafKey, committedFrame.revision, publishedHref, queryClient, router, setNavigationPending, setPendingHref])

  return {
    captureIntent,
    publishedHref,
    navigationPending,
    pendingHref,
    push,
    pushImmediate,
    replace,
    resolveAndPush,
    cancelPendingNavigation,
  }
}
