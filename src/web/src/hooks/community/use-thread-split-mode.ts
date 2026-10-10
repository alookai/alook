"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useLayoutEffect, type RefCallback } from "react"
import type { Breakpoint } from "@/hooks/use-mobile"

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
  breakpoint,
  enabled,
  forceFullscreen,
}: {
  breakpoint: Breakpoint
  enabled: boolean
  forceFullscreen: boolean
}): {
  containerRef: RefCallback<HTMLElement>
  mode: "pending" | "split" | "full"
} {
  const [container, setContainer] = useAtom(useCreateAtom<HTMLElement | null>(null))
  const [contentWidth, setContentWidth] = useAtom(useCreateAtom<number | null>(null))
  const containerRef = useCallback((node: HTMLElement | null) => {
    setContentWidth(null)
    setContainer(node)
  }, [setContainer, setContentWidth])

  const measureEnabled = enabled && breakpoint === "desktop" && !forceFullscreen
  useLayoutEffect(() => {
    if (!container || !measureEnabled) {
      setContentWidth(null)
      return
    }
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
  }, [container, measureEnabled, setContentWidth])

  const mode = enabled ? resolveThreadSplitMode({ breakpoint, contentWidth, forceFullscreen }) : "full"

  return { containerRef, mode }
}
