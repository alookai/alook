"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  commitLatestNavigationIntent,
  createNavigationIntentGate,
  supersedeNavigationIntent,
} from "@/lib/community/navigation-intent"
import type { ShellRouter } from "./shell-frame-types"

export type CommunityNavigationController = {
  currentHref: string
  navigationPending: boolean
  push: (href: string) => void
  replace: (href: string) => void
  prefetch: (href: string) => void
  resolveAndPush: (resolve: () => Promise<string>) => Promise<boolean>
  cancelPendingNavigation: () => void
}

export function useCommunityNavigationController(): CommunityNavigationController {
  const router = useRouter() as ShellRouter
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const currentHref = search ? `${pathname}?${search}` : pathname
  const gateRef = useRef(createNavigationIntentGate())
  const [navigationPending, setNavigationPending] = useState(false)

  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(false)
  }, [])

  useEffect(() => {
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(false)
  }, [currentHref])

  const push = useCallback((href: string) => {
    if (href === currentHref) return
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(true)
    router.push(href)
  }, [currentHref, router])

  const replace = useCallback((href: string) => {
    if (href === currentHref) return
    supersedeNavigationIntent(gateRef.current)
    setNavigationPending(true)
    router.replace(href)
  }, [currentHref, router])

  const resolveAndPush = useCallback(async (resolve: () => Promise<string>) => {
    setNavigationPending(true)
    try {
      return await commitLatestNavigationIntent(gateRef.current, resolve, (href) => {
        if (href === currentHref) {
          setNavigationPending(false)
          return
        }
        router.push(href)
      })
    } catch (error) {
      setNavigationPending(false)
      throw error
    }
  }, [currentHref, router])

  return {
    currentHref,
    navigationPending,
    push,
    replace,
    prefetch: router.prefetch,
    resolveAndPush,
    cancelPendingNavigation,
  }
}
