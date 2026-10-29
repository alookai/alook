"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { isTauri } from "@alook/shared"

type KeyboardSnapshot = { bottomInset: number; viewportWidth: number }
type KeyboardBridge = {
  postMessage: (command: "snapshot" | "dismiss") => Promise<KeyboardSnapshot>
}
type KeyboardWindow = Window & {
  webkit?: { messageHandlers?: { alookKeyboard?: KeyboardBridge } }
}

function keyboardBridge() {
  if (!isTauri()) return
  return (window as KeyboardWindow).webkit?.messageHandlers?.alookKeyboard
}

export function useNativeKeyboard() {
  const [bottomInset, setBottomInset] = useState(0)
  const current = useRef<{ bridge: KeyboardBridge; active: boolean } | null>(null)
  useEffect(() => {
    const bridge = keyboardBridge()
    if (!bridge) return
    const owner = { bridge, active: true }
    current.current = owner
    let revision = 0
    const sync = async () => {
      if (!owner.active) return
      const request = ++revision
      try {
        const next = await bridge.postMessage("snapshot")
        if (owner.active && request === revision) {
          const valid = next && Number.isFinite(next.bottomInset) && next.bottomInset >= 0
            && Number.isFinite(next.viewportWidth) && next.viewportWidth > 0
          setBottomInset(valid ? next.bottomInset * window.innerWidth / next.viewportWidth : 0)
        }
      } catch {
        if (owner.active && request === revision) setBottomInset(0)
      }
    }
    const hide = () => { owner.active = false; revision++; setBottomInset(0) }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      owner.active = true
      void sync()
    }
    window.addEventListener("alook:keyboard-change", sync)
    window.addEventListener("resize", sync)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    void sync()
    return () => {
      owner.active = false
      if (current.current === owner) current.current = null
      revision++
      window.removeEventListener("alook:keyboard-change", sync)
      window.removeEventListener("resize", sync)
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
    }
  }, [])
  const dismiss = useCallback(() => {
    const owner = current.current
    if (owner?.active) void owner.bridge.postMessage("dismiss").catch(() => {
      if (owner.active) console.error("Native keyboard dismissal failed")
    })
  }, [])
  return { visible: bottomInset > 0, bottomInset, dismiss }
}
