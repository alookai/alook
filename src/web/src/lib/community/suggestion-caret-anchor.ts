export type SuggestionCaretAnchorProps = {
  editor?: {
    state?: {
      selection?: {
        head?: number
        to?: number
      }
    }
    view?: {
      coordsAtPos: (position: number) => {
        top: number
        bottom: number
        left: number
        right: number
      }
    }
  }
  range?: { to: number }
  clientRect?: (() => DOMRect | null) | null
}

type CaretCoordinates = {
  top: number
  bottom: number
  left: number
  right: number
}

function rectFromCaretCoordinates(
  coordinates: CaretCoordinates,
): DOMRect {
  const { top, bottom, left, right } = coordinates
  return {
    top,
    bottom,
    left,
    right,
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    toJSON: () => ({ top, bottom, left, right }),
  }
}

/**
 * TipTap's suggestion `clientRect` spans the whole trigger/query range. Once
 * that text wraps, its top edge stays on the first line even though the live
 * caret has moved several lines below. Resolve the collapsed terminal caret
 * from the editor selection instead; both @ mentions and / channel refs share
 * this seam so their popup geometry cannot drift apart again.
 */
export function createSuggestionCaretRectResolver(
  props: SuggestionCaretAnchorProps,
): (() => DOMRect | null) | null {
  const view = props.editor?.view
  if (!view) return props.clientRect ?? null

  return () => {
    const position = props.editor?.state?.selection?.head
      ?? props.editor?.state?.selection?.to
      ?? props.range?.to
    if (position === undefined) return props.clientRect?.() ?? null

    try {
      return rectFromCaretCoordinates(view.coordsAtPos(position))
    } catch {
      // The suggestion lifecycle can race an editor teardown. The range rect
      // is imperfect for wrapped text, but is the safest transient fallback.
      return props.clientRect?.() ?? null
    }
  }
}
