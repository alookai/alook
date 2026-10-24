"use client"

import { useEffect, useState } from "react"
import { isMobile } from "@alook/shared"

type NativeWindow = Window & {
  AlookNative?: { getSafeAreaTop?: () => number }
  webkit?: {
    messageHandlers?: {
      alookSafeArea?: { postMessage: (body: null) => Promise<number | null> }
    }
  }
}

export function useNativeSafeAreaTop() {
  const [top, setTop] = useState<number | null>(null)

  useEffect(() => {
    if (!isMobile()) return
    const nativeWindow = window as NativeWindow
    let revision = 0
    let active = true
    const sync = async () => {
      const request = ++revision
      let next: number | null | undefined = null
      try {
        next = nativeWindow.AlookNative?.getSafeAreaTop
          ? nativeWindow.AlookNative.getSafeAreaTop()
          : await nativeWindow.webkit?.messageHandlers?.alookSafeArea?.postMessage(null)
      } catch {
        next = null
      }
      if (active && request === revision) {
        setTop(typeof next === "number" && Number.isFinite(next) && next >= 0 ? next : null)
      }
    }
    window.addEventListener("alook:safe-area-change", sync)
    void sync()
    return () => {
      active = false
      window.removeEventListener("alook:safe-area-change", sync)
    }
  }, [])

  return top
}
