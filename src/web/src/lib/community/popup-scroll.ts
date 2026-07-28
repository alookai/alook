// Keyboard-driven scroll for the composer's suggestion popovers (@-mention,
// /-channel-ref). Pure so it's unit-testable without a DOM: given the list
// container's current scroll offset + viewport height and the selected row's
// container-relative top + height, returns the scrollTop that keeps the row
// fully visible with the least movement.
//
// Why not `element.scrollIntoView({block:"nearest"})`: the popover is a
// `position:fixed` portal transformed by `translateY(-100%)`, and the mention
// list interleaves a "Members" section-header sibling — both break the
// index/geometry `scrollIntoView` relies on, so the highlight moved while the
// list never scrolled. Setting `scrollTop` from container-relative `offsetTop`
// sidesteps both.

const MARGIN = 4

export function nextListScrollTop(
  scrollTop: number,
  clientHeight: number,
  elemTop: number,
  elemHeight: number,
): number {
  // Above the viewport → pull the row's top into view.
  if (elemTop < scrollTop + MARGIN) {
    return Math.max(0, elemTop - MARGIN)
  }
  // Below the viewport → align the row's bottom to the viewport bottom.
  const elemBottom = elemTop + elemHeight
  if (elemBottom > scrollTop + clientHeight - MARGIN) {
    return elemBottom - clientHeight + MARGIN
  }
  // Already fully visible → no movement.
  return scrollTop
}
