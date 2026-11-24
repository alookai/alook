import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"

const MIN_HTML_PREVIEW_HEIGHT = 80
const MAX_HTML_PREVIEW_HEIGHT = 2000
const SCROLL_IDLE_HIDE_MS = 800
const TRACK_PADDING_PX = 2
const MIN_THUMB_HEIGHT_PX = 24
const OVERFLOW_EPSILON_PX = 1

export type HtmlPreviewScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null
  return (
    element.closest<HTMLElement>("[data-slot='scroll-area-viewport']")
    ?? element.closest("[data-message-list-content]")?.parentElement
    ?? null
  )
}

function readViewportHeight(element: HTMLElement | null): number {
  const container = findScrollContainer(element)
  if (container) {
    const measured = container.clientHeight || container.getBoundingClientRect().height
    if (measured > 0) return Math.round(measured)
  }
  return typeof window !== "undefined" && window.innerHeight > 0 ? Math.round(window.innerHeight) : 0
}

function computeMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return MAX_HTML_PREVIEW_HEIGHT
  return Math.max(
    MIN_HTML_PREVIEW_HEIGHT,
    Math.min(MAX_HTML_PREVIEW_HEIGHT, Math.floor(viewportHeight * 0.5)),
  )
}

export type HtmlPreviewScrollFade = "none" | "top" | "bottom" | "both"

export function buildHtmlPreviewScrollFadeMask(fade: HtmlPreviewScrollFade): string | undefined {
  if (fade === "both") {
    return "linear-gradient(to bottom, transparent 0px, black 28px, black calc(100% - 36px), transparent 100%)"
  }
  if (fade === "top") {
    return "linear-gradient(to bottom, transparent 0px, black 28px, black 100%)"
  }
  if (fade === "bottom") {
    return "linear-gradient(to bottom, black 0px, black calc(100% - 36px), transparent 100%)"
  }
  return undefined
}

export function useHtmlPreviewViewport({
  rootRef,
  frameRef,
  naturalHeight,
}: {
  rootRef: RefObject<HTMLDivElement | null>
  frameRef: RefObject<HTMLIFrameElement | null>
  naturalHeight: number
}) {
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window !== "undefined" && window.innerHeight > 0 ? Math.round(window.innerHeight) : 0,
  )
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [scrollMetrics, setScrollMetrics] = useState<HtmlPreviewScrollMetrics | null>(null)
  const [hovering, setHovering] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const [dragging, setDragging] = useState(false)

  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastReportedScrollTopRef = useRef<number | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node
    if (!node) {
      setContainer(null)
      return
    }
    const nextContainer = findScrollContainer(node)
    setContainer((prev) => (prev === nextContainer ? prev : nextContainer))
    const nextHeight = readViewportHeight(node)
    if (nextHeight > 0) {
      setViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight))
    }
  }, [rootRef])

  useEffect(() => {
    const sync = () => {
      const nextHeight = readViewportHeight(rootRef.current)
      if (nextHeight > 0) {
        setViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight))
      }
    }
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null
    if (container && observer) observer.observe(container)
    window.addEventListener("resize", sync)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [container, rootRef])

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) {
      clearTimeout(scrollIdleTimerRef.current)
      scrollIdleTimerRef.current = null
    }
    dragCleanupRef.current?.()
    dragCleanupRef.current = null
  }, [])

  const armScrollIdleHide = useCallback(() => {
    setScrolling(true)
    if (scrollIdleTimerRef.current !== null) clearTimeout(scrollIdleTimerRef.current)
    scrollIdleTimerRef.current = setTimeout(() => {
      scrollIdleTimerRef.current = null
      setScrolling(false)
    }, SCROLL_IDLE_HIDE_MS)
  }, [])

  const reportScrollMetrics = useCallback((next: HtmlPreviewScrollMetrics) => {
    const previousTop = lastReportedScrollTopRef.current
    lastReportedScrollTopRef.current = next.scrollTop
    if (previousTop !== null && Math.abs(next.scrollTop - previousTop) > 0.5) {
      armScrollIdleHide()
    }
    setScrollMetrics((prev) => (
      prev
      && prev.scrollTop === next.scrollTop
      && prev.scrollHeight === next.scrollHeight
      && prev.clientHeight === next.clientHeight
        ? prev
        : next
    ))
  }, [armScrollIdleHide])

  const maxHeight = computeMaxHeight(viewportHeight)
  const renderedHeight = Math.max(MIN_HTML_PREVIEW_HEIGHT, Math.min(maxHeight, naturalHeight))
  const effectiveScrollHeight = scrollMetrics && scrollMetrics.scrollHeight > 0
    ? scrollMetrics.scrollHeight
    : naturalHeight
  const effectiveClientHeight = scrollMetrics && scrollMetrics.clientHeight > 0
    ? scrollMetrics.clientHeight
    : renderedHeight
  const maxScrollTop = Math.max(0, effectiveScrollHeight - effectiveClientHeight)
  const scrollTop = scrollMetrics ? Math.max(0, Math.min(maxScrollTop, scrollMetrics.scrollTop)) : 0
  const canScroll = maxScrollTop > OVERFLOW_EPSILON_PX
  const canScrollUp = canScroll && scrollTop > OVERFLOW_EPSILON_PX
  const canScrollDown = canScroll && scrollTop < maxScrollTop - OVERFLOW_EPSILON_PX
  const scrollFade: HtmlPreviewScrollFade =
    canScrollUp && canScrollDown
      ? "both"
      : canScrollUp
        ? "top"
        : canScrollDown
          ? "bottom"
          : "none"
  const maskImage = buildHtmlPreviewScrollFadeMask(scrollFade)

  const trackHeight = Math.max(0, effectiveClientHeight - TRACK_PADDING_PX * 2)
  const thumbHeight = trackHeight > 0
    ? Math.max(
        MIN_THUMB_HEIGHT_PX,
        Math.min(trackHeight, Math.round((effectiveClientHeight / Math.max(1, effectiveScrollHeight)) * trackHeight)),
      )
    : 0
  const maxThumbOffset = Math.max(0, trackHeight - thumbHeight)
  const thumbOffset = maxScrollTop > 0 ? Math.round((scrollTop / maxScrollTop) * maxThumbOffset) : 0

  const scrollIframeTo = useCallback((rawTop: number) => {
    const clamped = Math.max(0, Math.min(maxScrollTop, rawTop))
    lastReportedScrollTopRef.current = clamped
    setScrollMetrics((prev) => ({
      scrollTop: clamped,
      scrollHeight: prev?.scrollHeight && prev.scrollHeight > 0 ? prev.scrollHeight : effectiveScrollHeight,
      clientHeight: prev?.clientHeight && prev.clientHeight > 0 ? prev.clientHeight : effectiveClientHeight,
    }))
    frameRef.current?.contentWindow?.postMessage({ type: "alook-html-scroll-to", top: clamped }, "*")
  }, [effectiveClientHeight, effectiveScrollHeight, frameRef, maxScrollTop])

  const beginDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    initialScrollTop: number,
  ) => {
    const startY = event.clientY
    const target = event.currentTarget
    const pointerId = event.pointerId
    try {
      target.setPointerCapture?.(pointerId)
    } catch {
      // Synthetic pointer events in JSDOM may not have an active pointerId.
    }
    setDragging(true)
    armScrollIdleHide()

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const deltaY = moveEvent.clientY - startY
      const nextTop = maxThumbOffset > 0
        ? initialScrollTop + (deltaY / maxThumbOffset) * maxScrollTop
        : initialScrollTop
      scrollIframeTo(nextTop)
      armScrollIdleHide()
    }

    const endDrag = (endEvent?: PointerEvent) => {
      if (endEvent && endEvent.pointerId !== pointerId) return
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", endDrag)
      window.removeEventListener("pointercancel", endDrag)
      dragCleanupRef.current = null
      try {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
      } catch {
        // Ignore if capture was already released.
      }
      setDragging(false)
    }

    dragCleanupRef.current?.()
    dragCleanupRef.current = () => endDrag()
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", endDrag)
    window.addEventListener("pointercancel", endDrag)
  }, [armScrollIdleHide, maxScrollTop, maxThumbOffset, scrollIframeTo])

  const handleTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canScroll) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const innerTop = rect.top + TRACK_PADDING_PX
    const clickOffset = Math.max(0, Math.min(maxThumbOffset, event.clientY - innerTop - thumbHeight / 2))
    const targetTop = maxThumbOffset > 0 ? (clickOffset / maxThumbOffset) * maxScrollTop : 0
    scrollIframeTo(targetTop)
    beginDrag(event, targetTop)
  }, [beginDrag, canScroll, maxScrollTop, maxThumbOffset, scrollIframeTo, thumbHeight])

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canScroll) return
    event.stopPropagation()
    event.preventDefault()
    beginDrag(event, scrollTop)
  }, [beginDrag, canScroll, scrollTop])

  const handleRootPointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") setHovering(true)
  }, [])

  const handleRootPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") setHovering((prev) => (prev ? prev : true))
  }, [])

  const handleRootPointerLeave = useCallback(() => {
    setHovering(false)
  }, [])

  return {
    attachRoot,
    renderedHeight,
    canScroll,
    scrollFade,
    maskImage,
    dragging,
    scrollbarVisible: hovering || scrolling || dragging,
    thumbHeight,
    thumbOffset,
    reportScrollMetrics,
    handleRootPointerEnter,
    handleRootPointerMove,
    handleRootPointerLeave,
    handleTrackPointerDown,
    handleThumbPointerDown,
  }
}
