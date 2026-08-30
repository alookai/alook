"use client"

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
  contentWidth: number
  forceFullscreen: boolean
}): "split" | "full" {
  if (forceFullscreen || breakpoint !== "desktop") return "full"
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
  mode: "split" | "full"
} {
  const breakpoint = useBreakpoint()
  const [subscriptionOwner] = useState(() => Symbol("thread-split-secondary"))
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [contentWidth, setContentWidth] = useState(0)
  const containerRef = useCallback((node: HTMLElement | null) => setContainer(node), [])

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
  }, [container])

  const mode = resolveThreadSplitMode({ breakpoint, contentWidth, forceFullscreen })
  useLayoutEffect(() => {
    if (mode === "split" && parentChannelId) {
      communityWsClaimSecondaryChannel(subscriptionOwner, parentChannelId)
    } else {
      communityWsReleaseSecondaryChannel(subscriptionOwner)
    }
    return () => communityWsReleaseSecondaryChannel(subscriptionOwner)
  }, [mode, parentChannelId, subscriptionOwner])

  return { containerRef, mode }
}
