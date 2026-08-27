"use client"

import { useCallback, useLayoutEffect, useRef } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useCurrentUser } from "@/contexts/community/current-user"
import { channelHref, removeCommunityParam } from "@/lib/community/community-route"
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntentGeneration,
} from "./read-coordinator"
import {
  armThreadOpenerReservationHandoff,
  clearThreadOpenerReservationHandoff,
  completeThreadOpenerReservationHandoff,
  getThreadOpenerReservationHandoff,
  registerThreadOpenerRouteLease,
  releaseThreadOpenerRouteLease,
  terminateThreadOpenerReservationHandoff,
  type ThreadOpenerHandoffTarget,
} from "./inbox-read-reservation"

export const THREAD_OPENER_HANDOFF_PARAM = "inboxThreadOpener"

let fallbackNonce = 0

function createNonce() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  fallbackNonce += 1
  return `opener-${fallbackNonce}`
}

export function armThreadOpenerReadHandoff(
  queryClient: ReturnType<typeof useQueryClient>,
  target: Omit<ThreadOpenerHandoffTarget, "nonce">,
) {
  const nonce = createNonce()
  armThreadOpenerReservationHandoff(queryClient, { ...target, nonce })
  const href = channelHref(target.serverId, target.childChannelId)
  return `${href}?${THREAD_OPENER_HANDOFF_PARAM}=${encodeURIComponent(nonce)}`
}

export function clearThreadOpenerReadHandoff(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  clearThreadOpenerReservationHandoff(queryClient)
}

type RouteLifecycle = "pending" | "ready" | "terminal-error"

export type ThreadOpenerReadHandoff = NonNullable<
  ReturnType<typeof getThreadOpenerReservationHandoff>
>

export function useThreadOpenerRouteGate({
  serverId,
  childChannelId,
  parentChannelId,
  openerMessageId,
  lifecycle,
}: {
  serverId: string
  childChannelId: string
  parentChannelId: string | null
  openerMessageId: string | null
  lifecycle: RouteLifecycle
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const nonce = searchParams.get(THREAD_OPENER_HANDOFF_PARAM)
  const handoff = nonce
    ? getThreadOpenerReservationHandoff(queryClient, nonce)
    : null
  const cleanUrl = useCallback(() => {
    if (!nonce) return
    const search = searchParams.toString()
    const href = `${channelHref(serverId, childChannelId)}${search ? `?${search}` : ""}`
    router.replace(
      removeCommunityParam(href, THREAD_OPENER_HANDOFF_PARAM),
      { scroll: false },
    )
  }, [childChannelId, nonce, router, searchParams, serverId])
  const routeMatches = !!handoff
    && handoff.serverId === serverId
    && handoff.childChannelId === childChannelId
  const routeAligned = pathname === channelHref(serverId, childChannelId)
  const canonicalMatches = routeMatches
    && lifecycle === "ready"
    && handoff.parentChannelId === parentChannelId
    && handoff.openerMessageId === openerMessageId

  useLayoutEffect(() => {
    if (!nonce || !routeAligned) return
    const lease = registerThreadOpenerRouteLease(
      queryClient,
      nonce,
      serverId,
      childChannelId,
    )
    return () => releaseThreadOpenerRouteLease(lease)
  }, [childChannelId, nonce, queryClient, routeAligned, serverId])

  useLayoutEffect(() => {
    if (!nonce || !routeAligned) return
    if (!routeMatches || lifecycle === "terminal-error") {
      terminateThreadOpenerReservationHandoff(queryClient, nonce)
      cleanUrl()
      return
    }
    if (lifecycle === "ready" && !canonicalMatches) {
      terminateThreadOpenerReservationHandoff(queryClient, nonce)
      cleanUrl()
      return
    }
  }, [canonicalMatches, cleanUrl, lifecycle, nonce, queryClient, routeAligned, routeMatches])

  return routeAligned && canonicalMatches && handoff ? handoff : null
}

export function useClaimThreadOpenerReadHandoff(
  target: ReturnType<typeof getThreadOpenerReservationHandoff> | undefined,
) {
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const router = useRouter()
  const searchParams = useSearchParams()
  const leaseRef = useRef<ReturnType<typeof registerReadSurface> | null>(null)
  const claimedNonceRef = useRef<string | null>(null)
  const lifetimeEpochRef = useRef(0)

  useLayoutEffect(() => {
    if (!target || claimedNonceRef.current === target.nonce) return
    if (leaseRef.current) {
      releaseReadSurface(leaseRef.current)
      leaseRef.current = null
      claimedNonceRef.current = null
    }
    const current = getThreadOpenerReservationHandoff(queryClient, target.nonce)
    if (
      !current
      || current.serverId !== target.serverId
      || current.parentChannelId !== target.parentChannelId
      || current.childChannelId !== target.childChannelId
      || current.openerMessageId !== target.openerMessageId
      || current.openerSeq !== target.openerSeq
    ) {
      terminateThreadOpenerReservationHandoff(queryClient, target.nonce)
      return
    }
    const lease = registerReadSurface(
      queryClient,
      currentUser.id,
      { kind: "timeline", channelId: current.parentChannelId },
      0,
      "cancel-uncommitted",
    )
    const generation = submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: current.parentChannelId,
      messageId: current.openerMessageId,
      seq: current.openerSeq,
    })
    if (generation === null) {
      releaseReadSurface(lease)
      terminateThreadOpenerReservationHandoff(queryClient, current.nonce)
      return
    }
    leaseRef.current = lease
    claimedNonceRef.current = current.nonce
    completeThreadOpenerReservationHandoff(queryClient, current.nonce, generation)
    const search = searchParams.toString()
    const href = `${channelHref(current.serverId, current.childChannelId)}${search ? `?${search}` : ""}`
    router.replace(
      removeCommunityParam(href, THREAD_OPENER_HANDOFF_PARAM),
      { scroll: false },
    )
  }, [currentUser.id, queryClient, router, searchParams, target])

  useLayoutEffect(() => {
    lifetimeEpochRef.current += 1
    return () => {
      const releaseEpoch = ++lifetimeEpochRef.current
      const lease = leaseRef.current
      if (!lease) return
      queueMicrotask(() => {
        if (
          lifetimeEpochRef.current !== releaseEpoch
          || leaseRef.current !== lease
        ) return
        leaseRef.current = null
        claimedNonceRef.current = null
        releaseReadSurface(lease)
      })
    }
  }, [queryClient])
}
