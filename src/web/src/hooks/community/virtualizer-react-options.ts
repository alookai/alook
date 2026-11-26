import { observeElementRect, type Rect, type Virtualizer } from "@tanstack/react-virtual"

export const COMMUNITY_VIRTUALIZER_REACT_OPTIONS = {
  useFlushSync: false,
  directDomUpdates: true,
} as const

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
