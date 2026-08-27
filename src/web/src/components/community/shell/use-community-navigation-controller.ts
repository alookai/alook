"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  commitLatestNavigationIntent,
  createNavigationIntentGate,
  supersedeNavigationIntent,
} from "@/lib/community/navigation-intent"
import { communityServerId, serverRootHref } from "@/lib/community/community-route"
import type { ShellRouter } from "./shell-frame-types"

export type CommunityNavigationController = {
  currentHref: string
  navigationPending: boolean
  pendingHref: string | null
  push: (href: string) => void
  replace: (href: string) => void
  prefetch: (href: string) => void
  resolveAndPush: (resolve: () => Promise<string>) => Promise<boolean>
  cancelPendingNavigation: () => void
}

function hasCommittedPendingHref(currentHref: string, pendingHref: string): boolean {
  if (currentHref === pendingHref) return true
  const pendingServerId = communityServerId(pendingHref)
  if (!pendingServerId) return false
  const pendingPathname = pendingHref.split(/[?#]/, 1)[0]
  return pendingPathname === serverRootHref(pendingServerId)
    && communityServerId(currentHref) === pendingServerId
}

export function useCommunityNavigationController(): CommunityNavigationController {
  const router = useRouter() as ShellRouter
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const currentHref = search ? `${pathname}?${search}` : pathname
  const gateRef = useRef(createNavigationIntentGate())
  const [navigationPending, setNavigationPending] = useState(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(false)
    setPendingHref(null)
  }, [])

  useEffect(() => {
    // A stale route commit must not clear a newer synchronous intent. Keep the
    // latest pending href until that exact destination becomes current; Shell
    // navigation intent/cancellation still clears it explicitly.
    if (pendingHref !== null && !hasCommittedPendingHref(currentHref, pendingHref)) return
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(false)
    if (pendingHref !== null) setPendingHref(null)
  }, [currentHref, pendingHref])

  const push = useCallback((href: string) => {
    if (href === currentHref) return
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(true)
    setPendingHref(href)
    router.push(href)
  }, [currentHref, router])

  const replace = useCallback((href: string) => {
    if (href === currentHref) return
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(true)
    setPendingHref(href)
    router.replace(href)
  }, [currentHref, router])

  const resolveAndPush = useCallback(async (resolve: () => Promise<string>) => {
    setNavigationPending(true)
    setPendingHref(null)
    try {
      return await commitLatestNavigationIntent(gateRef.current, resolve, (href) => {
        if (href === currentHref) {
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
  }, [currentHref, router])

  return {
    currentHref,
    navigationPending,
    pendingHref,
    push,
    replace,
    prefetch: router.prefetch,
    resolveAndPush,
    cancelPendingNavigation,
  }
}
