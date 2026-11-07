// Drag-to-highlight for the share card.
//
// The card body is Streamdown-rendered rich markdown — a DOM tree of
// <p>/<strong>/<em>/<a>/… A user's text selection can span multiple elements,
// so we CANNOT `range.surroundContents()` (it throws on a range that partially
// selects a non-Text node). Instead we wrap only the TEXT NODES the selection
// covers (splitting the boundary nodes so only the selected slice is wrapped)
// in a `<mark>`. The mark is a plain DOM element with a CSS background, so
// html-to-image rasterises it into the exported PNG (WYSIWYG).
//

const HIGHLIGHT_CLASS = "share-hl"
const HIGHLIGHT_ATTR = "data-hl"

/** A text node modeled as data: its text length + whether it already sits
 * inside an existing highlight (those are skipped so drags don't nest marks). */
export type PlanNode = { length: number; insideMark: boolean }

/** The selection, expressed as indices into the `PlanNode[]` array + offsets
 * within the boundary nodes (mirrors a DOM Range's start/end container+offset,
 * but resolved to array indices). */
export type PlanRange = {
  startIdx: number
  startOffset: number
  endIdx: number
  endOffset: number
}

/** One wrap instruction: wrap `[sliceStart, sliceEnd)` of node `idx`. A slice
 * covering the whole node is `sliceStart === 0 && sliceEnd === length`. */
export type WrapOp = { idx: number; sliceStart: number; sliceEnd: number }

/** Per-text-node coverage, computed from the live Range by the DOM layer and
 * fed to the pure resolver. `covered` = the range intersects this node.
 * `startOffset`/`endOffset` are set only when the node is the range's boundary
 * text node (start offset on the first boundary, end offset on the last);
 * undefined means "boundary landed on an element, use the whole node". */
export type NodeCoverage = {
  length: number
  insideMark: boolean
  covered: boolean
  startOffset?: number
  endOffset?: number
}

/**
 * PURE. Turn per-node coverage into a `PlanRange` (first→last covered node,
 * with boundary offsets), then delegate to `planHighlight`. This is where the
 * element-boundary decision lives — a triple-click / select-all lands both
 * range endpoints on elements, so EVERY covered text node between the first
 * and last must be included (the old DOM-side `findIdx` collapsed end→first
 * covered node, dropping everything after the first). Returns [] if nothing is
 * covered.
 */
export function planFromCoverage(nodes: NodeCoverage[]): WrapOp[] {
  let startIdx = -1
  let endIdx = -1
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].covered) {
      if (startIdx === -1) startIdx = i
      endIdx = i
    }
  }
  if (startIdx === -1) return []
  const startOffset = nodes[startIdx].startOffset ?? 0
  const endOffset = nodes[endIdx].endOffset ?? nodes[endIdx].length
  return planHighlight(nodes, { startIdx, startOffset, endIdx, endOffset })
}

export function planHighlight(nodes: PlanNode[], range: PlanRange): WrapOp[] {
  const { startIdx, startOffset, endIdx, endOffset } = range
  if (startIdx > endIdx) return []
  const ops: WrapOp[] = []
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const node = nodes[idx]
    if (!node || node.insideMark) continue
    const sliceStart = idx === startIdx ? startOffset : 0
    const sliceEnd = idx === endIdx ? endOffset : node.length

    const lo = Math.max(0, Math.min(sliceStart, node.length))
    const hi = Math.max(0, Math.min(sliceEnd, node.length))
    if (hi > lo) ops.push({ idx, sliceStart: lo, sliceEnd: hi })
  }
  return ops
}

function isInsideHighlight(node: Node): boolean {
  let el: Node | null = node.parentNode
  const stop = node.ownerDocument?.body ?? null
  while (el && el !== stop) {
    if (el.nodeType === 1 && (el as Element).hasAttribute?.(HIGHLIGHT_ATTR)) return true
    el = el.parentNode
  }
  return false
}

function textNodesUnder(container: Node): Text[] {
  const doc = container.ownerDocument ?? document
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n as Text).data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  const out: Text[] = []
  let n = walker.nextNode()
  while (n) {
    out.push(n as Text)
    n = walker.nextNode()
  }
  return out
}

function wrapSlice(text: Text, sliceStart: number, sliceEnd: number): void {

  let node = text
  if (sliceEnd < node.data.length) node.splitText(sliceEnd)
  if (sliceStart > 0) node = node.splitText(sliceStart)
  const mark = (node.ownerDocument ?? document).createElement("mark")
  mark.setAttribute(HIGHLIGHT_ATTR, "")
  mark.className = HIGHLIGHT_CLASS
  node.parentNode?.replaceChild(mark, node)
  mark.appendChild(node)
}

export function applyHighlightToRange(container: Node, range: Range): number {
  if (range.collapsed) return 0
  const nodes = textNodesUnder(container)
  if (nodes.length === 0) return 0

  const coverage: NodeCoverage[] = nodes.map((t) => {

    const covered =
      typeof range.intersectsNode === "function"
        ? range.intersectsNode(t)
        : range.comparePoint(t, 0) === 0 || range.comparePoint(t, t.data.length) === 0
    return {
      length: t.data.length,
      insideMark: isInsideHighlight(t),
      covered,

      ...(t === range.startContainer ? { startOffset: range.startOffset } : {}),
      ...(t === range.endContainer ? { endOffset: range.endOffset } : {}),
    }
  })

  const ops = planFromCoverage(coverage)

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    wrapSlice(nodes[op.idx], op.sliceStart, op.sliceEnd)
  }
  return ops.length
}

export function clearHighlights(container: Element): void {
  const marks = container.querySelectorAll(`mark[${HIGHLIGHT_ATTR}]`)
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
  })
  container.normalize()
}

export function hasHighlights(container: Element): boolean {
  return container.querySelector(`mark[${HIGHLIGHT_ATTR}]`) !== null
}
