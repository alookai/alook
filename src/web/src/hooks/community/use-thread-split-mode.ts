"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useLayoutEffect, type RefCallback } from "react"
import type { Breakpoint } from "@/hooks/use-mobile"

type ThreadSplitMode = "pending" | "split" | "full"

export function useThreadSplitMode({ breakpoint, enabled, forceFullscreen }: {
  breakpoint: Breakpoint
  enabled: boolean
  forceFullscreen: boolean
}): { modeMarkerRef: RefCallback<HTMLElement>; mode: ThreadSplitMode } {
  const [marker, setMarker] = useAtom(useCreateAtom<HTMLElement | null>(null))
  const [cssMode, setCssMode] = useAtom(useCreateAtom<ThreadSplitMode>("pending"))
  const modeMarkerRef = useCallback((node: HTMLElement | null) => {
    setCssMode("pending")
    setMarker(node)
  }, [setMarker, setCssMode])

  const measureEnabled = enabled && breakpoint === "desktop" && !forceFullscreen
  useLayoutEffect(() => {
    const container = marker?.parentElement
    if (!marker || !container || !measureEnabled) {
      setCssMode("pending")
      return
    }
    let active = true
    const measure = () => {
      if (!active) return
      const value = window.getComputedStyle(marker).getPropertyValue("--thread-split-mode").trim()
      setCssMode(value === "split" || value === "full" ? value : "pending")
    }
    measure()
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure)
      return () => { active = false; window.removeEventListener("resize", measure) }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => { active = false; observer.disconnect() }
  }, [marker, measureEnabled, setCssMode])

  const mode = !enabled || forceFullscreen || breakpoint === "mobile"
    ? "full"
    : breakpoint === "unknown" ? "pending" : cssMode
  return { modeMarkerRef, mode }
}
