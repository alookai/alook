"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCommunityRuntime } from "@/stores/community/runtime"

import { useCallback, useLayoutEffect, useState, type RefCallback } from "react"
import { useBreakpoint, type Breakpoint } from "@/hooks/use-mobile"
import {
  communityWsClaimSecondaryChannel,
  communityWsReleaseSecondaryChannel,
} from "@/hooks/community/use-community-ws"

export const THREAD_SPLIT_MIN_CONTENT_WIDTH = 880

export function resolveThreadSplitMode({
  breakpoint,
  contentWidth,
  forceFullscreen,
}: {
  breakpoint: Breakpoint
  contentWidth: number | null
  forceFullscreen: boolean
}): "pending" | "split" | "full" {
  if (forceFullscreen || breakpoint === "mobile") return "full"
  if (breakpoint === "unknown" || contentWidth === null) return "pending"
  return contentWidth >= THREAD_SPLIT_MIN_CONTENT_WIDTH ? "split" : "full"
}

export function useThreadSplitMode({
  parentChannelId,
  forceFullscreen,
}: {
  parentChannelId: string | null
  forceFullscreen: boolean
}): {
  containerRef: RefCallback<HTMLElement>
  mode: "pending" | "split" | "full"
} {
  const runtime = useCommunityRuntime()
  const breakpoint = useBreakpoint()
  const [subscriptionOwner] = useState(() => Symbol("thread-split-secondary"))
  const [container, setContainer] = useAtom(useCreateAtom<HTMLElement | null>(null))
  const [contentWidth, setContentWidth] = useAtom(useCreateAtom<number | null>(null))
  const containerRef = useCallback((node: HTMLElement | null) => {
    setContentWidth(null)
    setContainer(node)
  }, [setContainer, setContentWidth])

  useLayoutEffect(() => {
    if (!container) return
    const measure = () => setContentWidth(container.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure)
      return () => window.removeEventListener("resize", measure)
    }
    const observer = new ResizeObserver(([entry]) => {
      setContentWidth(entry?.contentRect.width ?? container.getBoundingClientRect().width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container, setContentWidth])

  const mode = resolveThreadSplitMode({ breakpoint, contentWidth, forceFullscreen })
  useLayoutEffect(() => {
    if (mode === "split" && parentChannelId) {
      communityWsClaimSecondaryChannel(runtime, subscriptionOwner, parentChannelId)
    } else {
      communityWsReleaseSecondaryChannel(runtime, subscriptionOwner)
    }
    return () => communityWsReleaseSecondaryChannel(runtime, subscriptionOwner)
  }, [mode, parentChannelId, subscriptionOwner, runtime])

  return { containerRef, mode }
}
