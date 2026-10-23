"use client"

import { beginNavigation, navigationNoop, type Action } from "@/lib/observability/context"
import { prepareNavigationMetadata } from "@/lib/community/navigation-metadata"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { flushSync } from "react-dom"
import { usePathname, useSearchParams } from "next/navigation"
import { useCommunityHistoryRouter as useRouter } from "@/lib/community/navigation"
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
import type { CommunityNavigationController } from "@/contexts/community/route-frame"
export type { CommunityNavigationController } from "@/contexts/community/route-frame"

export function hasPendingParentReturn({ entryIntent, navigationPending, pendingHref }: Pick<CommunityNavigationController, "entryIntent" | "navigationPending" | "pendingHref">) {
  return navigationPending && pendingHref !== null && entryIntent?.resume === true
    && normalizeCommunityHref(entryIntent.href).href === normalizeCommunityHref(pendingHref).href
}

export function useCommunityNavigationController(
  committedFrame: CommunityCommittedFrame,
): CommunityNavigationController {
  const router = useRouter()
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
  const settledIntentRef = useRef<{
    revision: number
    frameRevision: number
    href: string
  } | null>(null)
  const captureIntent = useCallback<CommunityNavigationController["captureIntent"]>((options) => {
    const pendingCommit = options !== undefined && "pendingCommitHref" in options
    const revision = gateRef.current.revision + (options && "nextCommitHref" in options ? 1 : 0)
    const frameRevision = committedFrameRef.current.revision
    const target = options ? normalizeCommunityHref("pendingCommitHref" in options
      ? options.pendingCommitHref : options.nextCommitHref) : null
    const targetHref = target?.href ?? null
    const targetRevision = frameRevision + (target !== null
      && target.leafKey !== committedFrameRef.current.leafKey ? 1 : 0)
    return () => {
      if (!mountedRef.current) return false
      if (revision === gateRef.current.revision && (frameRevision === committedFrameRef.current.revision
        || target !== null && targetRevision === committedFrameRef.current.revision
          && target?.leafKey === committedFrameRef.current.leafKey)) return true
      const settled = settledIntentRef.current
      return targetHref !== null && settled !== null
        && settled.revision === revision && gateRef.current.revision === revision + 1
        && settled.frameRevision === targetRevision
        && settled.frameRevision === committedFrameRef.current.revision
        && settled.href === targetHref
        && (pendingCommit
          ? committedFrameRef.current.leafKey === target?.leafKey
          : committedFrameRef.current.href === targetHref)
    }
  }, [])
  const pendingBaselineRevisionRef = useRef(committedFrame.revision)
  const pendingBaselineLeafRef = useRef(committedFrame.leafKey)
  const [navigationPending, setNavigationPending] = useAtom(useCreateAtom(false))
  const [pendingHref, setPendingHref] = useAtom(useCreateAtom<string | null>(null))
  const [entryIntent, setEntryIntent] = useAtom(useCreateAtom<{ href: string; resume?: boolean } | null>(null))

  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(gateRef.current)
    setEntryIntent(null)
    setNavigationPending(false)
    setPendingHref(null)
  }, [setEntryIntent, setNavigationPending, setPendingHref])

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
    if (!settled || !isPublishedNonStructuralCommit(committedFrame, publishedHref, pendingHref)) return
    settledIntentRef.current = {
      revision: gateRef.current.revision,
      frameRevision: committedFrame.revision,
      href: target.href,
    }
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

  const submitNavigation = useCallback((submit: () => void, isCurrent?: () => boolean) => {
    if (isCurrent && !isCurrent()) return
    const revision = gateRef.current.revision
    try {
      submit()
    } catch (error) {
      if (revision === gateRef.current.revision) cancelPendingNavigation()
      throw error
    }
  }, [cancelPendingNavigation])

  const push = useCallback((...args: Parameters<typeof router.push>) => {
    const [href] = args
    setEntryIntent({ href })
    if (href === publishedHref && !navigationPending) { settledIntentRef.current = null; navigationNoop(href); return }
    beginNavigation(href)
    void prepareNavigationMetadata(queryClient, href, "foreground")
    supersedeNavigationIntent(gateRef.current)
    const isCurrent = captureIntent({ pendingCommitHref: href })
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    // Publish the target checkpoint before Next starts the RSC transition.
    // Otherwise React can leave this event-batched behind a suspended push and
    // the committed conversation remains visible while the target is pending.
    flushSync(() => {
      setNavigationPending(true)
      setPendingHref(href)
    })
    submitNavigation(() => router.push(...args), isCurrent)
  }, [captureIntent, committedFrame.leafKey, committedFrame.revision, navigationPending, publishedHref, queryClient, router, setEntryIntent, setNavigationPending, setPendingHref, submitNavigation])

  const pushImmediate = useCallback((href: string, prepare?: (action?: Action) => void) => {
    setEntryIntent({ href })
    if (href === publishedHref && !navigationPending) { settledIntentRef.current = null; navigationNoop(href); prepare?.(); return }
    const action = beginNavigation(href)
    prepare?.(action)
    void prepareNavigationMetadata(queryClient, href, "foreground")
    supersedeNavigationIntent(gateRef.current)
    const isCurrent = captureIntent({ pendingCommitHref: href })
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    // Inbox promises a target checkpoint on the next paint. Publish it before
    // Next starts the RSC transition instead of leaving it in the event batch.
    flushSync(() => {
      setNavigationPending(true)
      setPendingHref(href)
    })
    submitNavigation(() => router.push(href), isCurrent)
  }, [captureIntent, committedFrame.leafKey, committedFrame.revision, navigationPending, publishedHref, queryClient, router, setEntryIntent, setNavigationPending, setPendingHref, submitNavigation])

  const replace = useCallback((href: string, options?: { resume?: boolean }) => {
    setEntryIntent({ href, ...(options?.resume ? { resume: true } : {}) })
    if (href === publishedHref && !navigationPending) { settledIntentRef.current = null; navigationNoop(href); return }
    beginNavigation(href)
    void prepareNavigationMetadata(queryClient, href, "foreground")
    supersedeNavigationIntent(gateRef.current)
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    setNavigationPending(true)
    setPendingHref(href)
    submitNavigation(() => router.replace(href))
  }, [committedFrame.leafKey, committedFrame.revision, navigationPending, publishedHref, queryClient, router, setEntryIntent, setNavigationPending, setPendingHref, submitNavigation])

  const resolveAndPush = useCallback(async (resolve: () => Promise<string>) => {
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
        setEntryIntent({ href })
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
  }, [committedFrame.leafKey, committedFrame.revision, publishedHref, queryClient, router, setEntryIntent, setNavigationPending, setPendingHref])

  return {
    entryIntent,
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
