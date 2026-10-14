import { useEffect } from "react"

export const MOBILE_BACK_EDGE_PX = 24

export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"

const dismissibleLayerSelector = [
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
].join(",")

function dismissTopDocumentLayer(): boolean {
  const layers = document.querySelectorAll(dismissibleLayerSelector)
  if (layers.length === 0) return false
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  }))
  return true
}

export function useNativeMobileBack({
  mobile = false,
  gestureKey,
  dismissShellOverlay,
  parentPath,
  replacePath,
}: {
  mobile?: boolean
  gestureKey?: string
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
}) {
  useEffect(() => {
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      if (dismissTopDocumentLayer() || dismissShellOverlay()) return
      if (parentPath) replacePath(parentPath)
    }

    let gesture: { id: number; x: number; y: number; horizontal: boolean } | null = null
    const cancel = () => { gesture = null }
    const start = (event: TouchEvent) => {
      cancel()
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      if (touch.clientX < 0 || touch.clientX > MOBILE_BACK_EDGE_PX) return
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false }
    }
    const move = (event: TouchEvent) => {
      if (!gesture) return
      if (!event.cancelable) return cancel()
      const touch = event.touches[0]
      if (event.touches.length !== 1 || touch.identifier !== gesture.id) return cancel()
      const dx = touch.clientX - gesture.x
      const dy = Math.abs(touch.clientY - gesture.y)
      if (!gesture.horizontal && Math.max(Math.abs(dx), dy) >= 8) {
        if (dx <= dy) return cancel()
        gesture.horizontal = true
      }
      if (gesture.horizontal) event.preventDefault()
    }
    const end = (event: TouchEvent) => {
      const current = gesture
      cancel()
      if (!current?.horizontal || event.touches.length !== 0) return
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.id)
      if (!touch) return
      event.preventDefault()
      if (touch.clientX - current.x < 64 || Math.abs(touch.clientY - current.y) >= touch.clientX - current.x) return
      handleBack(event)
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    if (mobile) {
      document.addEventListener("touchstart", start, { passive: true, capture: true })
      document.addEventListener("touchmove", move, { passive: false, capture: true })
      document.addEventListener("touchend", end, { passive: false, capture: true })
      document.addEventListener("touchcancel", cancel, true)
    }
    return () => {
      window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
      document.removeEventListener("touchstart", start, true)
      document.removeEventListener("touchmove", move, true)
      document.removeEventListener("touchend", end, true)
      document.removeEventListener("touchcancel", cancel, true)
    }
  }, [mobile, gestureKey, dismissShellOverlay, parentPath, replacePath])
}
