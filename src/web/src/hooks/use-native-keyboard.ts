"use client"

import { useSyncExternalStore } from "react"
import { isTauri } from "@alook/shared"

type KeyboardSnapshot = { bottomInset: number; viewportWidth: number; isAnimating?: boolean }
type KeyboardBridge = { postMessage: (command: "snapshot") => Promise<KeyboardSnapshot> }
type KeyboardWindow = Window & {
  AlookNative?: { getKeyboardSnapshot?: () => string }
  webkit?: { messageHandlers?: { alookKeyboard?: KeyboardBridge } }
}

function keyboardBridge() {
  if (!isTauri()) return
  const nativeWindow = window as KeyboardWindow
  if (nativeWindow.AlookNative?.getKeyboardSnapshot) {
    return { postMessage: async () => JSON.parse(nativeWindow.AlookNative!.getKeyboardSnapshot!()) as KeyboardSnapshot }
  }
  return nativeWindow.webkit?.messageHandlers?.alookKeyboard
}

function createKeyboardOwner() {
  let snapshot: KeyboardSnapshot | null = null
  const subscribers = new Set<() => void>()
  let dispose: (() => void) | undefined
  let revision = 0
  const settle = (next: KeyboardSnapshot | null) => {
    if (snapshot?.bottomInset === next?.bottomInset && snapshot?.viewportWidth === next?.viewportWidth) return
    snapshot = next
    for (const subscriber of subscribers) subscriber()
  }
  const clearProjection = () => {
    document.documentElement.style.removeProperty("--alook-keyboard-progress")
    document.documentElement.style.removeProperty("--alook-keyboard-bottom")
  }
  const start = () => {
    if (!isTauri()) return () => {}
    let active = true
    let animating = false
    let initialized = false
    const valid = (next: KeyboardSnapshot | undefined): next is KeyboardSnapshot => !!next
      && Number.isFinite(next.bottomInset) && next.bottomInset >= 0
      && Number.isFinite(next.viewportWidth) && next.viewportWidth > 0
      && Number.isFinite(next.bottomInset / next.viewportWidth * 100)
    const project = (next: KeyboardSnapshot) => {
      const root = document.documentElement.style
      const inset = `${next.bottomInset / next.viewportWidth * 100}vw`
      root.setProperty("--alook-keyboard-bottom", inset)
      if (next.bottomInset === 0) root.removeProperty("--alook-keyboard-progress")
      else root.setProperty("--alook-keyboard-progress", `max(0px, calc(${inset} - var(--app-safe-area-bottom)))`)
    }
    const sync = async () => {
      if (!active || animating) return
      const request = ++revision
      const bridge = keyboardBridge()
      if (!bridge) { clearProjection(); settle(null); return }
      try {
        const next = await bridge.postMessage("snapshot")
        if (active && request === revision) {
          initialized = valid(next)
          if (initialized) project(next)
          else clearProjection()
          settle(initialized ? { bottomInset: next.bottomInset, viewportWidth: next.viewportWidth } : null)
        }
      } catch {
        if (active && request === revision) { clearProjection(); settle(null) }
      }
    }
    const change = (event: Event) => {
      if (!active || !keyboardBridge()) return
      const detail = (event as CustomEvent<KeyboardSnapshot>).detail
      if (!valid(detail)) { void sync(); return }
      revision++
      animating = detail.isAnimating === true
      project(detail)
      if (animating) {
        if (!initialized) { initialized = true; settle({ bottomInset: 0, viewportWidth: detail.viewportWidth }) }
      } else {
        initialized = true
        settle({ bottomInset: detail.bottomInset, viewportWidth: detail.viewportWidth })
      }
    }
    const hide = () => { active = false; animating = false; revision++; clearProjection(); settle(null) }
    const show = (event: PageTransitionEvent) => { if (event.persisted) { active = true; void sync() } }
    window.addEventListener("alook:keyboard-change", change)
    window.addEventListener("alook:geometry-change", sync)
    window.addEventListener("resize", sync)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    void sync()
    return () => {
      active = false
      revision++
      window.removeEventListener("alook:keyboard-change", change)
      window.removeEventListener("alook:geometry-change", sync)
      window.removeEventListener("resize", sync)
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
      clearProjection()
      settle(null)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (callback: () => void) => {
      subscribers.add(callback)
      if (!dispose) dispose = start()
      return () => {
        subscribers.delete(callback)
        if (subscribers.size === 0) { dispose?.(); dispose = undefined }
      }
    },
  }
}
const owners = new WeakMap<Window, ReturnType<typeof createKeyboardOwner>>()
const serverSnapshot = () => null

export function useNativeKeyboard(): KeyboardSnapshot | null {
  const owner = (() => {
    if (typeof window === "undefined") return null
    let current = owners.get(window)
    if (!current) { current = createKeyboardOwner(); owners.set(window, current) }
    return current
  })()
  return useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.getSnapshot ?? serverSnapshot, serverSnapshot)
}

export function NativeKeyboardSync() {
  useNativeKeyboard()
  return null
}
