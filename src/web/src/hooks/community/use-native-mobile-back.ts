import { useEffect } from "react"

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
  dismissShellOverlay,
  parentPath,
  replacePath,
}: {
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
}) {
  useEffect(() => {
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      if (dismissTopDocumentLayer() || dismissShellOverlay()) {
        event.preventDefault()
        return
      }
      if (!parentPath) return
      event.preventDefault()
      replacePath(parentPath)
    }

    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    return () => window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
  }, [dismissShellOverlay, parentPath, replacePath])
}
