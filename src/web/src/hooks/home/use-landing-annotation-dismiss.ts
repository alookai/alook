import { useEffect } from "react"

const DISMISS_EVENTS: (keyof WindowEventMap)[] = ["pointerdown", "touchstart", "wheel", "keydown"]

export function useLandingAnnotationDismiss(
  dismissed: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (dismissed) return
    DISMISS_EVENTS.forEach((type) =>
      window.addEventListener(type, onDismiss, { capture: true, passive: type !== "keydown" }),
    )
    return () => {
      DISMISS_EVENTS.forEach((type) => window.removeEventListener(type, onDismiss, true))
    }
  }, [dismissed, onDismiss])
}
