"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import {
  createNavigationIntentGate,
  isLatestNavigationIntent,
  supersedeNavigationIntent,
} from "@/lib/community/navigation-intent"
import {
  isPublishedNonStructuralCommit,
  isStructuralFrameCommit,
  normalizeCommunityHref,
  resolveCommunityModulePlan,
  type CommunityCommittedFrame,
} from "@/lib/community/community-route"
import type { ShellNavigationOptions, ShellRouter } from "./shell-frame-types"
import { cancelActiveConversationNavigationProof } from "@/lib/community/conversation-navigation-proof"
import { startConversationNavigationWarmup } from "@/lib/community/conversation-navigation-warmup"

export type CommunityNavigationController = {
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
  push: (href: string, options?: ShellNavigationOptions) => void
  replace: (href: string, options?: ShellNavigationOptions) => void
  prefetch: (href: string) => void
  resolveAndPush: (
    intentHref: string,
    resolve: () => Promise<string>,
    options?: ShellNavigationOptions,
  ) => Promise<boolean>
  cancelPendingNavigation: () => void
}

export function useCommunityNavigationController(
  committedFrame: CommunityCommittedFrame,
  viewerId: string,
  accessEpoch: number,
): CommunityNavigationController {
  const router = useRouter() as ShellRouter
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const publishedHref = search ? `${pathname}?${search}` : pathname
  const queryClient = useQueryClient()
  const gateRef = useRef(createNavigationIntentGate())
  const resolvingRevisionRef = useRef<number | null>(null)
  const pendingBaselineRevisionRef = useRef(committedFrame.revision)
  const pendingBaselineLeafRef = useRef(committedFrame.leafKey)
  const [navigationPending, setNavigationPending] = useState(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(gateRef.current)
    resolvingRevisionRef.current = null
    cancelActiveConversationNavigationProof(queryClient)
    setNavigationPending(false)
    setPendingHref(null)
  }, [queryClient])

  useEffect(() => {
    if (pendingHref === null) return
    if (resolvingRevisionRef.current !== null) return
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

  const prepareTarget = useCallback((href: string, options?: ShellNavigationOptions) => {
    const plan = resolveCommunityModulePlan(href)
    if (plan.main.kind === "server-conversation") {
      startConversationNavigationWarmup(queryClient, {
        href,
        viewerId,
        channelId: plan.main.leafId,
        serverId: plan.main.serverId,
        scopeKind: "channel",
        ...(options?.anchorMessageId ? { anchorMessageId: options.anchorMessageId } : {}),
        ...(options?.expectedSurfaceKind
          ? { expectedSurfaceKind: options.expectedSurfaceKind }
          : {}),
      }, accessEpoch)
      return
    }
    if (plan.main.kind === "dm") {
      startConversationNavigationWarmup(queryClient, {
        href,
        viewerId,
        channelId: plan.main.dmId,
        scopeKind: "dm",
        expectedSurfaceKind: "dm",
        ...(options?.anchorMessageId ? { anchorMessageId: options.anchorMessageId } : {}),
      }, accessEpoch)
      return
    }
    cancelActiveConversationNavigationProof(queryClient)
  }, [accessEpoch, queryClient, viewerId])

  const publishTargetCheckpoint = useCallback((href: string) => {
    pendingBaselineRevisionRef.current = committedFrame.revision
    pendingBaselineLeafRef.current = committedFrame.leafKey
    flushSync(() => {
      setNavigationPending(true)
      setPendingHref(href)
    })
  }, [committedFrame.leafKey, committedFrame.revision])

  const commitResolvedTarget = useCallback((
    href: string,
    method: "push" | "replace",
    options?: ShellNavigationOptions,
  ) => {
    prepareTarget(href, options)
    if (href === publishedHref) {
      flushSync(() => {
        setNavigationPending(false)
        setPendingHref(null)
      })
      return
    }
    publishTargetCheckpoint(href)
    router[method](href)
  }, [prepareTarget, publishTargetCheckpoint, publishedHref, router])

  const push = useCallback((href: string, options?: ShellNavigationOptions) => {
    supersedeNavigationIntent(gateRef.current)
    resolvingRevisionRef.current = null
    commitResolvedTarget(href, "push", options)
  }, [commitResolvedTarget])

  const replace = useCallback((href: string, options?: ShellNavigationOptions) => {
    supersedeNavigationIntent(gateRef.current)
    resolvingRevisionRef.current = null
    commitResolvedTarget(href, "replace", options)
  }, [commitResolvedTarget])

  const resolveAndPush = useCallback(async (
    intentHref: string,
    resolve: () => Promise<string>,
    options?: ShellNavigationOptions,
  ) => {
    const revision = supersedeNavigationIntent(gateRef.current)
    resolvingRevisionRef.current = revision
    cancelActiveConversationNavigationProof(queryClient)
    publishTargetCheckpoint(intentHref)
    try {
      const href = await resolve()
      if (!isLatestNavigationIntent(gateRef.current, revision)) return false
      resolvingRevisionRef.current = null
      commitResolvedTarget(href, "push", options)
      return true
    } catch (error) {
      if (isLatestNavigationIntent(gateRef.current, revision)) {
        resolvingRevisionRef.current = null
        flushSync(() => {
          setNavigationPending(false)
          setPendingHref(null)
        })
      }
      throw error
    }
  }, [commitResolvedTarget, publishTargetCheckpoint, queryClient])

  return {
    publishedHref,
    navigationPending,
    pendingHref,
    push,
    replace,
    prefetch: router.prefetch,
    resolveAndPush,
    cancelPendingNavigation,
  }
}
