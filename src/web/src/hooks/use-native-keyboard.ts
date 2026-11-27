"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { isTauri } from "@alook/shared"

export type OverlayGpuKeyboardPacket = {
  mode: "overlay-gpu"
  targetInset: number
  viewportWidth: number
  durationMs: number
  easing: string
  phase: "animating" | "settled"
  sequence: number
}

export type KeyboardSnapshot = {
  bottomInset: number
  viewportWidth: number
  isAnimating?: boolean
  mode?: "legacy" | "overlay-gpu"
}

export type KeyboardSettleEvent = {
  previousInsetPx: number
  nextInsetPx: number
  deltaInsetPx: number
  sequence: number
}

type KeyboardPacket = KeyboardSnapshot | OverlayGpuKeyboardPacket | { resizesViewport: true }
type KeyboardBridge = { postMessage: (command: "snapshot") => Promise<KeyboardPacket> }
type KeyboardWindow = Window & {
  __alookNativeBridge?: { getKeyboardSnapshot?: () => KeyboardPacket | string | null }
  __alookNativeGeometry?: {
    getSnapshot?: () => { insets?: { bottom?: number; viewportWidth?: number } | null }
  }
  webkit?: { messageHandlers?: { alookKeyboard?: KeyboardBridge } }
}

const DEFAULT_GPU_EASING = "cubic-bezier(0.32, 0.72, 0, 1)"
const MAX_GPU_DURATION_MS = 1000
const SETTLE_SAFETY_BUFFER_MS = 120
const SAFE_EASING_RE = /^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\))$/

function sanitizeEasing(value: unknown): string {
  return typeof value === "string" && SAFE_EASING_RE.test(value.trim()) ? value.trim() : DEFAULT_GPU_EASING
}

function readSafeAreaBottomPx(): number {
  const nativeInsets = (window as KeyboardWindow).__alookNativeGeometry?.getSnapshot?.().insets
  if (
    nativeInsets
    && Number.isFinite(nativeInsets.bottom)
    && Number.isFinite(nativeInsets.viewportWidth)
    && (nativeInsets.viewportWidth ?? 0) > 0
  ) {
    return Math.max(0, ((nativeInsets.bottom ?? 0) / nativeInsets.viewportWidth!) * window.innerWidth)
  }
  const inline = document.documentElement.style.getPropertyValue("--app-safe-area-bottom").trim()
  const raw = inline || (typeof getComputedStyle === "function"
    ? getComputedStyle(document.documentElement).getPropertyValue("--app-safe-area-bottom").trim()
    : "")
  if (!raw) return 0
  if (raw.endsWith("vw")) {
    const vw = Number.parseFloat(raw)
    return Number.isFinite(vw) ? Math.max(0, (vw / 100) * window.innerWidth) : 0
  }
  if (raw.endsWith("px")) {
    const px = Number.parseFloat(raw)
    return Number.isFinite(px) ? Math.max(0, px) : 0
  }
  return 0
}

function computeEffectiveInsetPx(inset: number, viewportWidth: number): number {
  if (!Number.isFinite(inset) || inset <= 0 || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0
  const rawPx = (inset / viewportWidth) * window.innerWidth
  return Math.max(0, rawPx - readSafeAreaBottomPx())
}

function readCurrentGpuLayerTranslateY(): number {
  const layer = document.querySelector<HTMLElement>("[data-alook-kb-gpu-layer]:not([data-alook-kb-gpu-offset])")
  if (!layer || typeof getComputedStyle !== "function") return 0
  const transform = getComputedStyle(layer).transform
  if (!transform || transform === "none") return 0
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform)
  if (matrix3d) {
    const values = matrix3d[1].split(",").map((part) => Number.parseFloat(part.trim()))
    return values.length === 16 && Number.isFinite(values[13]) ? values[13] : 0
  }
  const matrix2d = /^matrix\(([^)]+)\)$/.exec(transform)
  if (matrix2d) {
    const values = matrix2d[1].split(",").map((part) => Number.parseFloat(part.trim()))
    return values.length === 6 && Number.isFinite(values[5]) ? values[5] : 0
  }
  return 0
}

function flushGpuLayerStyle(): void {
  const layer = document.querySelector<HTMLElement>("[data-alook-kb-gpu-layer]") ?? document.documentElement
  if (typeof getComputedStyle === "function") {
    void getComputedStyle(layer).transform
  }
  void layer.offsetHeight
}

function validOverlayGpu(next: unknown): next is OverlayGpuKeyboardPacket {
  if (!next || typeof next !== "object") return false
  const candidate = next as Partial<OverlayGpuKeyboardPacket>
  return candidate.mode === "overlay-gpu"
    && Number.isFinite(candidate.targetInset) && (candidate.targetInset as number) >= 0
    && Number.isFinite(candidate.viewportWidth) && (candidate.viewportWidth as number) > 0
    && Number.isFinite((candidate.targetInset as number) / (candidate.viewportWidth as number) * 100)
    && Number.isFinite(candidate.durationMs) && (candidate.durationMs as number) >= 0
    && (candidate.phase === "animating" || candidate.phase === "settled")
    && Number.isFinite(candidate.sequence) && (candidate.sequence as number) >= 0
}

function validLegacySnapshot(next: unknown): next is KeyboardSnapshot {
  if (!next || typeof next !== "object") return false
  const candidate = next as Partial<KeyboardSnapshot>
  return Number.isFinite(candidate.bottomInset) && (candidate.bottomInset as number) >= 0
    && Number.isFinite(candidate.viewportWidth) && (candidate.viewportWidth as number) > 0
    && Number.isFinite((candidate.bottomInset as number) / (candidate.viewportWidth as number) * 100)
}

function keyboardBridge() {
  if (!isTauri()) return
  const nativeWindow = window as KeyboardWindow
  if (nativeWindow.__alookNativeBridge?.getKeyboardSnapshot) {
    return {
      postMessage: async () => {
        const raw = nativeWindow.__alookNativeBridge!.getKeyboardSnapshot!()
        return (typeof raw === "string" ? JSON.parse(raw) : raw) as KeyboardPacket
      },
    }
  }
  return nativeWindow.webkit?.messageHandlers?.alookKeyboard
}

type ActiveTransition = {
  fromInsetPx: number
  toInsetPx: number
  deltaPx: number
  targetInset: number
  viewportWidth: number
  durationMs: number
  easing: string
  sequence: number
}

function createKeyboardOwner() {
  let snapshot: KeyboardSnapshot | null = null
  const subscribers = new Set<() => void>()
  const settleListeners = new Set<(event: KeyboardSettleEvent) => void>()
  let dispose: (() => void) | undefined
  let revision = 0
  const settle = (next: KeyboardSnapshot | null) => {
    if (
      snapshot?.bottomInset === next?.bottomInset
      && snapshot?.viewportWidth === next?.viewportWidth
      && snapshot?.mode === next?.mode
    ) return
    snapshot = next
    for (const subscriber of subscribers) subscriber()
  }
  const clearProjection = () => {
    const root = document.documentElement
    root.style.removeProperty("--alook-keyboard-progress")
    root.style.removeProperty("--alook-keyboard-bottom")
    root.style.removeProperty("--alook-kb-layout-progress")
    root.style.removeProperty("--alook-kb-visual-progress")
    root.style.removeProperty("--alook-kb-translate-y")
    root.style.removeProperty("--alook-kb-transition")
    root.removeAttribute("data-alook-kb-animating")
  }
  const start = () => {
    if (!isTauri()) return () => {}
    let active = true
    let animating = false
    let initialized = false
    let resizesViewport = false
    let overlayMode = false
    let settledInset = 0
    let settledViewportWidth = 0
    let settledEffectivePx = 0
    let lastSequence = -1
    let safetyTimer: number | undefined
    let activeTransition: ActiveTransition | null = null

    const clearSafetyTimer = () => {
      if (safetyTimer !== undefined) {
        window.clearTimeout(safetyTimer)
        safetyTimer = undefined
      }
    }

    const projectLayout = (bottomInset: number, viewportWidth: number) => {
      const root = document.documentElement.style
      const inset = `${bottomInset / viewportWidth * 100}vw`
      root.setProperty("--alook-keyboard-bottom", inset)
      if (bottomInset === 0) root.removeProperty("--alook-keyboard-progress")
      else root.setProperty("--alook-keyboard-progress", `max(0px, calc(${inset} - var(--app-safe-area-bottom)))`)
    }

    const commitOverlaySettle = (targetInset: number, viewportWidth: number, sequence: number) => {
      clearSafetyTimer()
      const wasAnimating = activeTransition !== null
      const alreadySettledAtTarget = !wasAnimating
        && initialized
        && overlayMode
        && settledInset === targetInset
        && settledViewportWidth === viewportWidth
      const previousInsetPx = settledEffectivePx
      const nextInsetPx = computeEffectiveInsetPx(targetInset, viewportWidth)
      const deltaInsetPx = nextInsetPx - previousInsetPx
      activeTransition = null
      animating = false
      overlayMode = true

      const rootEl = document.documentElement
      rootEl.style.setProperty("--alook-kb-transition", "none")
      rootEl.style.setProperty("--alook-kb-layout-progress", `${nextInsetPx}px`)
      rootEl.style.setProperty("--alook-kb-visual-progress", `${nextInsetPx}px`)
      rootEl.style.setProperty("--alook-kb-translate-y", "0px")
      rootEl.removeAttribute("data-alook-kb-animating")

      settledInset = targetInset
      settledViewportWidth = viewportWidth
      settledEffectivePx = nextInsetPx
      initialized = true
      projectLayout(targetInset, viewportWidth)

      if (!alreadySettledAtTarget && Math.abs(deltaInsetPx) > 0.01) {
        const event: KeyboardSettleEvent = {
          previousInsetPx,
          nextInsetPx,
          deltaInsetPx,
          sequence,
        }
        for (const listener of settleListeners) listener(event)
      }

      settle({ bottomInset: targetInset, viewportWidth, mode: "overlay-gpu" })
    }

    const applyOverlayPacket = (packet: OverlayGpuKeyboardPacket) => {
      if (packet.sequence < lastSequence) return
      if (packet.sequence === lastSequence && packet.phase === "animating" && activeTransition) return
      lastSequence = packet.sequence
      overlayMode = true
      resizesViewport = false
      revision++

      if (packet.phase === "settled" || packet.durationMs <= 0) {
        commitOverlaySettle(packet.targetInset, packet.viewportWidth, packet.sequence)
        return
      }

      if (!initialized) {
        initialized = true
        settledInset = 0
        settledViewportWidth = packet.viewportWidth
        settledEffectivePx = 0
        settle({ bottomInset: 0, viewportWidth: packet.viewportWidth, mode: "overlay-gpu" })
      }

      const effectiveTargetPx = computeEffectiveInsetPx(packet.targetInset, packet.viewportWidth)
      const easing = sanitizeEasing(packet.easing)
      const durationMs = Math.min(MAX_GPU_DURATION_MS, Math.round(packet.durationMs))
      const rootEl = document.documentElement

      if (effectiveTargetPx < settledEffectivePx - 0.01) {
        const previousInsetPx = settledEffectivePx
        const shrinkPx = previousInsetPx - effectiveTargetPx
        const currentTranslateY = activeTransition ? readCurrentGpuLayerTranslateY() : 0
        const startVisualPx = Math.max(effectiveTargetPx, previousInsetPx - currentTranslateY)
        const startTranslateY = -(startVisualPx - effectiveTargetPx)

        rootEl.setAttribute("data-alook-kb-animating", "true")
        rootEl.style.setProperty("--alook-kb-transition", "none")
        rootEl.style.setProperty("--alook-kb-layout-progress", `${effectiveTargetPx}px`)
        rootEl.style.setProperty("--alook-kb-visual-progress", `${startVisualPx}px`)
        rootEl.style.setProperty("--alook-kb-translate-y", `${startTranslateY}px`)

        settledInset = packet.targetInset
        settledViewportWidth = packet.viewportWidth
        settledEffectivePx = effectiveTargetPx
        initialized = true
        projectLayout(packet.targetInset, packet.viewportWidth)

        const event: KeyboardSettleEvent = {
          previousInsetPx,
          nextInsetPx: effectiveTargetPx,
          deltaInsetPx: -shrinkPx,
          sequence: packet.sequence,
        }
        for (const listener of settleListeners) listener(event)

        flushGpuLayerStyle()

        animating = true
        activeTransition = {
          fromInsetPx: startVisualPx,
          toInsetPx: effectiveTargetPx,
          deltaPx: 0,
          targetInset: packet.targetInset,
          viewportWidth: packet.viewportWidth,
          durationMs,
          easing,
          sequence: packet.sequence,
        }

        rootEl.style.setProperty("--alook-kb-transition", `transform ${durationMs}ms ${easing}`)
        rootEl.style.setProperty("--alook-kb-visual-progress", `${effectiveTargetPx}px`)
        rootEl.style.setProperty("--alook-kb-translate-y", "0px")
      } else {
        if (Math.abs(effectiveTargetPx - settledEffectivePx) <= 0.01 && !activeTransition) {
          commitOverlaySettle(packet.targetInset, packet.viewportWidth, packet.sequence)
          return
        }

        const deltaPx = -(effectiveTargetPx - settledEffectivePx)
        animating = true
        activeTransition = {
          fromInsetPx: settledEffectivePx,
          toInsetPx: effectiveTargetPx,
          deltaPx,
          targetInset: packet.targetInset,
          viewportWidth: packet.viewportWidth,
          durationMs,
          easing,
          sequence: packet.sequence,
        }

        rootEl.setAttribute("data-alook-kb-animating", "true")
        rootEl.style.setProperty("--alook-kb-layout-progress", `${settledEffectivePx}px`)
        rootEl.style.setProperty("--alook-kb-visual-progress", `${effectiveTargetPx}px`)
        rootEl.style.setProperty("--alook-kb-transition", `transform ${durationMs}ms ${easing}`)
        rootEl.style.setProperty("--alook-kb-translate-y", `${deltaPx}px`)
      }

      clearSafetyTimer()
      const expectedSeq = packet.sequence
      const targetInset = packet.targetInset
      const viewportWidth = packet.viewportWidth
      safetyTimer = window.setTimeout(() => {
        safetyTimer = undefined
        if (!active || activeTransition?.sequence !== expectedSeq) return
        commitOverlaySettle(targetInset, viewportWidth, expectedSeq)
      }, durationMs + SETTLE_SAFETY_BUFFER_MS)
    }

    const sync = async () => {
      if (!active || animating || resizesViewport) return
      const request = ++revision
      const bridge = keyboardBridge()
      if (!bridge) { clearSafetyTimer(); activeTransition = null; clearProjection(); settle(null); return }
      try {
        const next = await bridge.postMessage("snapshot")
        if (active && typeof next === "object" && next !== null && "resizesViewport" in next && next.resizesViewport === true) {
          resizesViewport = true
          overlayMode = false
          animating = false
          activeTransition = null
          clearSafetyTimer()
          revision++
          clearProjection()
          settle(null)
          return
        }
        if (active && request === revision) {
          if (validOverlayGpu(next)) {
            applyOverlayPacket(next)
            return
          }
          initialized = validLegacySnapshot(next)
          if (initialized) {
            overlayMode = false
            const legacy = next as KeyboardSnapshot
            projectLayout(legacy.bottomInset, legacy.viewportWidth)
            settle({ bottomInset: legacy.bottomInset, viewportWidth: legacy.viewportWidth })
          } else {
            clearSafetyTimer()
            activeTransition = null
            clearProjection()
            settle(null)
          }
        }
      } catch {
        if (active && request === revision) {
          clearSafetyTimer()
          activeTransition = null
          clearProjection()
          settle(null)
        }
      }
    }

    const change = (event: Event) => {
      if (!active || resizesViewport || !keyboardBridge()) return
      const detail = (event as CustomEvent<KeyboardPacket | undefined>).detail
      if (validOverlayGpu(detail)) {
        applyOverlayPacket(detail)
        return
      }
      if (detail && typeof detail === "object" && "resizesViewport" in detail && detail.resizesViewport === true) {
        resizesViewport = true
        overlayMode = false
        animating = false
        activeTransition = null
        clearSafetyTimer()
        revision++
        clearProjection()
        settle(null)
        return
      }
      if (!validLegacySnapshot(detail)) { void sync(); return }
      revision++
      overlayMode = false
      animating = detail.isAnimating === true
      projectLayout(detail.bottomInset, detail.viewportWidth)
      if (animating) {
        if (!initialized) { initialized = true; settle({ bottomInset: 0, viewportWidth: detail.viewportWidth }) }
      } else {
        initialized = true
        settle({ bottomInset: detail.bottomInset, viewportWidth: detail.viewportWidth })
      }
    }

    const onTransitionEnd = (event: TransitionEvent) => {
      if (!active || !activeTransition || event.propertyName !== "transform") return
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.hasAttribute("data-alook-kb-gpu-layer")) return
      commitOverlaySettle(
        activeTransition.targetInset,
        activeTransition.viewportWidth,
        activeTransition.sequence,
      )
    }

    const resetOverlayState = () => {
      clearSafetyTimer()
      activeTransition = null
      overlayMode = false
      settledInset = 0
      settledViewportWidth = 0
      settledEffectivePx = 0
      lastSequence = -1
    }

    const hide = () => {
      active = false
      animating = false
      resizesViewport = false
      initialized = false
      resetOverlayState()
      revision++
      clearProjection()
      settle(null)
    }
    const show = (event: PageTransitionEvent) => { if (event.persisted) { active = true; void sync() } }
    const handleSync = () => { void sync() }
    window.addEventListener("alook:keyboard-change", change)
    window.addEventListener("alook:geometry-change", handleSync)
    window.addEventListener("resize", handleSync)
    window.addEventListener("transitionend", onTransitionEnd)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    void sync()
    return () => {
      active = false
      revision++
      resetOverlayState()
      window.removeEventListener("alook:keyboard-change", change)
      window.removeEventListener("alook:geometry-change", handleSync)
      window.removeEventListener("resize", handleSync)
      window.removeEventListener("transitionend", onTransitionEnd)
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
    subscribeSettle: (listener: (event: KeyboardSettleEvent) => void) => {
      settleListeners.add(listener)
      return () => {
        settleListeners.delete(listener)
      }
    },
  }
}

const owners = new WeakMap<Window, ReturnType<typeof createKeyboardOwner>>()
const serverSnapshot = () => null

function getKeyboardOwner() {
  if (typeof window === "undefined") return null
  let current = owners.get(window)
  if (!current) {
    current = createKeyboardOwner()
    owners.set(window, current)
  }
  return current
}

export function registerNativeKeyboardSettle(listener: (event: KeyboardSettleEvent) => void): () => void {
  const owner = getKeyboardOwner()
  return owner ? owner.subscribeSettle(listener) : () => {}
}

export function useNativeKeyboardSettle(listener: (event: KeyboardSettleEvent) => void): void {
  const listenerRef = useRef(listener)
  useEffect(() => {
    listenerRef.current = listener
  }, [listener])
  useEffect(() => registerNativeKeyboardSettle((event) => {
    listenerRef.current(event)
  }), [])
}

export function useNativeKeyboard(): KeyboardSnapshot | null {
  const owner = getKeyboardOwner()
  return useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.getSnapshot ?? serverSnapshot, serverSnapshot)
}

export function NativeKeyboardSync() {
  useNativeKeyboard()
  return null
}
