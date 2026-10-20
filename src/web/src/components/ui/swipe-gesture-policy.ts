export type SwipeDirection = "left" | "right" | "up" | "down"

const INTERACTIVE_START = [
  "button", "a", "input", "textarea", "select", "label", "summary", "audio", "video", "canvas", "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']", "[role='link']", "[role='slider']", "[role='textbox']",
  "[role='spinbutton']", "[role='combobox']", "[role='tab']", "[role='option']", "[role='menuitem']",
  "[draggable='true']", "[data-swipe-ignore]",
  "[data-slot='resizable-handle']", "[data-dnd-handle]",
].join(",")

export function canStartSwipe({
  target, x, y, root, enabled, pointerType, touches = 1, kind = "overlay",
}: {
  target: EventTarget | null
  x: number
  y?: number
  root: HTMLElement
  enabled: boolean
  pointerType: string
  touches?: number
  kind?: "page" | "overlay"
}) {
  if (!enabled || pointerType !== "touch" || touches !== 1 || !(target instanceof Element)) return false
  if (target.closest(INTERACTIVE_START)) return false
  const document = root.ownerDocument
  const view = document.defaultView
  const selection = document.getSelection()
  if (!view || selection && !selection.isCollapsed && selection.rangeCount > 0) return false
  if (view.visualViewport && view.visualViewport.scale !== 1) return false
  const width = document.documentElement.clientWidth || view.innerWidth
  const edges = systemGestureEdges(view, width)
  if (!edges || x < edges.left || x > width - edges.right) return false
  if (kind === "page" && x > edges.left + Math.min(96, width / 4)) return false
  const height = document.documentElement.clientHeight || view.innerHeight
  if (y !== undefined && (y < 24 || y > height - 32)) return false
  for (let element: Element | null = target; element && root.contains(element); element = element.parentElement) {
    const ignore = element.getAttribute("data-base-ui-swipe-ignore")
    if (ignore !== null && !(kind === "page" && ignore === "y" && element.hasAttribute("data-page-swipe-reply-row"))) return false
    if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) {
      const overflow = view.getComputedStyle(element).overflowX
      if (overflow === "auto" || overflow === "scroll") return false
    }
    if (element === root) break
  }
  return true
}

export function isSystemSwipeStart(root: HTMLElement, x: number) {
  const view = root.ownerDocument.defaultView
  if (!view) return false
  const width = root.ownerDocument.documentElement.clientWidth || view.innerWidth
  const edges = systemGestureEdges(view, width)
  return edges !== null && (x < edges.left || x > width - edges.right)
}

function systemGestureEdges(view: Window, width: number): { left: number; right: number } | null {
  if (!/android/i.test(view.navigator.userAgent)) return { left: 0, right: 0 }
  const native = (view as Window & { AlookNative?: { getSystemGestureRegion?: () => string } }).AlookNative
  if (!native?.getSystemGestureRegion) return "__TAURI__" in view ? null : { left: 0, right: 0 }
  try {
    const region: unknown = JSON.parse(native.getSystemGestureRegion())
    if (!region || typeof region !== "object" || !("left" in region) || !("right" in region) || !("width" in region)) return null
    const { left, right, width: nativeWidth } = region
    if (typeof left !== "number" || typeof right !== "number" || typeof nativeWidth !== "number"
      || !Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(nativeWidth)
      || left < 0 || right < 0 || nativeWidth <= 0 || left + right > nativeWidth) return null
    return { left: left * width / nativeWidth, right: right * width / nativeWidth }
  } catch {
    return null
  }
}
