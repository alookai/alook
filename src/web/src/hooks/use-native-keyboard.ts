"use client"

import { useCallback, useEffect, useRef, useState } from "react"

type KeyboardBridge = {
  postMessage: (command: "snapshot" | "dismiss") => Promise<boolean>
}
type KeyboardWindow = Window & {
  webkit?: { messageHandlers?: { alookKeyboard?: KeyboardBridge } }
}

function keyboardBridge() {
  return (window as KeyboardWindow).webkit?.messageHandlers?.alookKeyboard
}

export function useNativeKeyboard() {
  const [visible, setVisible] = useState(false)
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
        if (owner.active && request === revision) setVisible(next === true)
      } catch {
        if (owner.active && request === revision) setVisible(false)
      }
    }
    const hide = () => { owner.active = false; revision++; setVisible(false) }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      owner.active = true
      void sync()
    }
    window.addEventListener("alook:keyboard-change", sync)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    void sync()
    return () => {
      owner.active = false
      if (current.current === owner) current.current = null
      revision++
      window.removeEventListener("alook:keyboard-change", sync)
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
  return { visible, dismiss }
}
