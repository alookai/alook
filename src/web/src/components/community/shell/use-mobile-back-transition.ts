"use client"

import { addTransitionType, startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type ViewTransitionInstance } from "react"
import { flushSync } from "react-dom"
import type { CommunityNavigationController } from "@/contexts/community/route-frame"
import type { MobileBackGesture } from "@/lib/community/mobile-back-gesture"

export const COMMUNITY_NAV_GESTURE = "community-nav-gesture"
const BACK_DURATION = 200

type Lease = {
  id: number
  href: string
  current: () => boolean
  progress: number
  decision: boolean | null
  animation: Animation | null
  closed: boolean
}

export function useMobileBackTransition({ mobile, parentPath, frameHref, navigation }: {
  mobile: boolean
  parentPath: string | null
  frameHref: string
  navigation: CommunityNavigationController
}) {
  const [preview, setPreview] = useState<{ id: number; href: string; committing: boolean } | null>(null)
  const active = useRef<Lease | null>(null)
  const sequence = useRef(0)
  const actions = useRef(navigation)
  useLayoutEffect(() => { actions.current = navigation }, [navigation])

  const restore = useCallback((lease: Lease, synchronous = true) => {
    if (lease.closed) return
    lease.closed = true
    if (active.current === lease) active.current = null
    lease.animation?.cancel()
    const clear = () => setPreview((current) => current?.id === lease.id ? null : current)
    if (synchronous) flushSync(clear)
    else clear()
  }, [])

  const commit = useCallback((lease: Lease) => {
    if (lease.closed) return
    if (!lease.current()) { restore(lease); return }
    lease.closed = true
    try {
      actions.current.replace(lease.href, { transitionTypes: [] })
      if (active.current === lease) active.current = null
      flushSync(() => setPreview((current) => current?.id === lease.id ? { ...current, committing: true } : current))
    } catch (error) {
      if (active.current === lease) active.current = null
      flushSync(() => setPreview(null))
      throw error
    }
  }, [restore])

  const settle = useCallback((lease: Lease) => {
    const animation = lease.animation
    if (lease.closed || lease.decision === null || !animation) return
    if (!lease.decision && lease.progress <= 0) { restore(lease); return }
    if (lease.decision && lease.progress >= 1) { animation.finish(); return }
    animation.playbackRate = lease.decision ? 1 : -1
    animation.play()
  }, [restore])

  const begin = useCallback((): MobileBackGesture | null => {
    if (!mobile || !parentPath || navigation.navigationPending || active.current
      || typeof document.startViewTransition !== "function"
      || typeof CSS === "undefined" || !CSS.supports?.("view-transition-class: community-page")
      || !CSS.supports("selector(:active-view-transition)")
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null
    const lease: Lease = { id: ++sequence.current, href: parentPath, current: navigation.captureIntent(),
      progress: 0, decision: null, animation: null, closed: false }
    active.current = lease
    startTransition(() => {
      addTransitionType(COMMUNITY_NAV_GESTURE)
      setPreview({ id: lease.id, href: lease.href, committing: false })
    })
    return {
      update: (progress) => {
        if (lease.closed || lease.decision !== null || !Number.isFinite(progress)) return
        lease.progress = Math.min(1, Math.max(0, progress))
        if (lease.animation) lease.animation.currentTime = lease.progress * BACK_DURATION
      },
      complete: () => {
        if (lease.closed) return false
        lease.decision = true
        settle(lease)
        return true
      },
      cancel: () => {
        if (lease.closed) return
        lease.decision = false
        settle(lease)
      },
      abort: () => restore(lease, false),
    }
  }, [mobile, navigation, parentPath, restore, settle])

  const attach = useCallback((instance: ViewTransitionInstance, id: number) => {
    const lease = active.current
    if (!lease || lease.closed || lease.id !== id) return
    let animation: Animation
    try {
      animation = document.documentElement.animate([
        { transform: "translateX(0%)" }, { transform: "translateX(100%)" },
      ], { duration: BACK_DURATION, easing: "linear", fill: "both",
        pseudoElement: `::view-transition-old(${instance.name})` })
    } catch {
      return
    }
    animation.pause()
    animation.currentTime = lease.progress * BACK_DURATION
    lease.animation = animation
    void animation.finished.then(() => {
      if (lease.closed) return
      if (lease.decision) commit(lease)
      else restore(lease)
    }).catch(() => { if (!lease.closed) restore(lease) })
    settle(lease)
    return () => {
      if (!lease.closed) restore(lease, false)
      else animation.cancel()
    }
  }, [commit, restore, settle])

  useEffect(() => {
    const lease = active.current
    if (!preview || !lease || lease.id !== preview.id || lease.animation) return
    queueMicrotask(() => {
      if (lease.closed || lease.animation) return
      if (lease.decision) commit(lease)
      else restore(lease, false)
    })
  }, [commit, preview, restore])

  useLayoutEffect(() => {
    if (preview && !active.current && (frameHref === preview.href || navigation.pendingHref !== preview.href)) {
      setPreview(null)
    }
  }, [frameHref, navigation.pendingHref, preview])

  useEffect(() => () => {
    const lease = active.current
    if (lease) {
      lease.closed = true
      lease.animation?.cancel()
      active.current = null
    }
  }, [])

  const isActive = useCallback(() => active.current !== null, [])
  const abort = useCallback(() => { if (active.current) restore(active.current, false) }, [restore])
  return { preview, begin, attach, isActive, abort }
}
