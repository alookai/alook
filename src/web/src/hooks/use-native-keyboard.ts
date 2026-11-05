"use client"

import { useEffect, useState } from "react"
import { isTauri } from "@alook/shared"

type KeyboardSnapshot = { bottomInset: number; viewportWidth: number; isAnimating?: boolean }
type KeyboardBridge = {
  postMessage: (command: "snapshot") => Promise<KeyboardSnapshot>
}
type KeyboardWindow = Window & {
  webkit?: { messageHandlers?: { alookKeyboard?: KeyboardBridge } }
}

function keyboardBridge() {
  if (!isTauri()) return
  return (window as KeyboardWindow).webkit?.messageHandlers?.alookKeyboard
}

export function useNativeKeyboard(): KeyboardSnapshot | null {
  const [snapshot, setSnapshot] = useState<KeyboardSnapshot | null>(null)
  useEffect(() => {
    const bridge = keyboardBridge()
    if (!bridge) return
    const owner = { active: true }
    let revision = 0
    let animating = false
    let initialized = false
    const project = (next: KeyboardSnapshot) => {
      const root = document.documentElement.style
      if (next.bottomInset === 0) root.removeProperty("--alook-keyboard-progress")
      else root.setProperty("--alook-keyboard-progress", `${100 * next.bottomInset / next.viewportWidth}vw`)
    }
    const valid = (next: KeyboardSnapshot | undefined): next is KeyboardSnapshot => !!next
      && Number.isFinite(next.bottomInset) && next.bottomInset >= 0
      && Number.isFinite(next.viewportWidth) && next.viewportWidth > 0
    const sync = async () => {
      if (!owner.active || animating) return
      const request = ++revision
      try {
        const next = await bridge.postMessage("snapshot")
        if (owner.active && request === revision) {
          initialized = valid(next)
          if (initialized) project(next)
          setSnapshot(initialized ? { bottomInset: next.bottomInset, viewportWidth: next.viewportWidth } : null)
        }
      } catch {
        if (owner.active && request === revision) setSnapshot(null)
      }
    }
    const change = (event: Event) => {
      if (!owner.active) return
      const detail = (event as CustomEvent<KeyboardSnapshot>).detail
      if (!valid(detail)) { void sync(); return }
      revision++
      animating = detail.isAnimating === true
      if (animating) {
        // Native display frames move the already-bound footer without React work.
        project(detail)
        if (!initialized) {
          initialized = true
          setSnapshot({ bottomInset: 0, viewportWidth: detail.viewportWidth })
        }
      } else {
        initialized = true
        project(detail)
        setSnapshot({ bottomInset: detail.bottomInset, viewportWidth: detail.viewportWidth })
      }
    }
    const hide = () => { animating = false; owner.active = false; revision++; setSnapshot(null) }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      owner.active = true
      void sync()
    }
    window.addEventListener("alook:keyboard-change", change)
    window.addEventListener("resize", sync)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    void sync()
    return () => {
      owner.active = false
      revision++
      window.removeEventListener("alook:keyboard-change", change)
      window.removeEventListener("resize", sync)
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
    }
  }, [])
  return snapshot
}
