import { useLayoutEffect, type RefObject } from "react"

export function useLandingBackendTrackWidth(
  trackRef: RefObject<HTMLSpanElement | null>,
  currentRef: RefObject<HTMLSpanElement | null>,
  providerId: string,
  reducedMotion: boolean,
): void {
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    if (reducedMotion) {
      track.style.width = ""
      return
    }
    const element = currentRef.current
    if (!element) return
    let active = true
    const measure = () => {
      if (!active || !currentRef.current || !trackRef.current) return
      const target = currentRef.current
      const width = Math.max(target.scrollWidth, target.offsetWidth, target.getBoundingClientRect().width)
      if (width > 0) trackRef.current.style.width = `${Math.ceil(width)}px`
    }
    measure()
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener("resize", measure)
    void document.fonts?.ready?.then(measure)
    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [currentRef, providerId, reducedMotion, trackRef])
}
