import { measureElement, observeElementRect, type Rect, type Virtualizer } from "@tanstack/react-virtual"

export const COMMUNITY_VIRTUALIZER_REACT_OPTIONS = {
  useFlushSync: false,
  directDomUpdates: true,
} as const

export function measureCommunityVirtualizerElement<TScrollElement extends Element, TItemElement extends Element>(
  element: TItemElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<TScrollElement, TItemElement>,
) {
  const measured = measureElement(element, entry, instance)
  if (measured > 0) return measured
  const index = Number(element.getAttribute(instance.options.indexAttribute))
  return Number.isFinite(index) ? instance.options.estimateSize(index) : measured
}

export function observeCommunityVirtualizerRect<TScrollElement extends Element, TItemElement extends Element>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  cb: (rect: Rect) => void,
) {
  const fallback = instance.options.initialRect
  return observeElementRect(instance, (rect) => {
    if (rect.height <= 0 && fallback && fallback.height > 0) {
      cb({ width: rect.width > 0 ? rect.width : fallback.width, height: fallback.height })
      return
    }
    cb(rect)
  })
}
