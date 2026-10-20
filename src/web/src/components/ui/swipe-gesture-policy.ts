export type SwipeDirection = "left" | "right" | "up" | "down"

const INTERACTIVE_START = [
  "button", "a", "input", "textarea", "select", "label", "summary", "audio", "video", "canvas", "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']", "[role='link']", "[role='slider']", "[role='textbox']",
  "[role='spinbutton']", "[role='combobox']", "[role='tab']", "[role='option']", "[role='menuitem']",
  "[draggable='true']", "[data-swipe-ignore]", "[data-base-ui-swipe-ignore]",
  "[data-slot='resizable-handle']", "[data-dnd-handle]",
].join(",")

export function canStartSwipe({
  target, x, y, root, enabled, pointerType, touches = 1,
}: {
  target: EventTarget | null
  x: number
  y?: number
  root: HTMLElement
  enabled: boolean
  pointerType: string
  touches?: number
}) {
  if (!enabled || pointerType !== "touch" || touches !== 1 || !(target instanceof Element)) return false
  if (target.closest(INTERACTIVE_START)) return false
  const document = root.ownerDocument
  const view = document.defaultView
  const selection = document.getSelection()
  if (!view || selection && !selection.isCollapsed && selection.rangeCount > 0) return false
  if (view.visualViewport && view.visualViewport.scale !== 1) return false
  const width = document.documentElement.clientWidth || view.innerWidth
  const edge = Math.min(64, width / 4)
  if (x < edge || x > width - edge) return false
  const height = document.documentElement.clientHeight || view.innerHeight
  if (y !== undefined && (y < 24 || y > height - 32)) return false
  for (let element: Element | null = target; element && root.contains(element); element = element.parentElement) {
    if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) {
      const overflow = view.getComputedStyle(element).overflowX
      if (overflow === "auto" || overflow === "scroll") return false
    }
    if (element === root) break
  }
  return true
}
