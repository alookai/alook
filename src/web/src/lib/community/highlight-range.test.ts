import { describe, it, expect } from "vitest"
import { planHighlight, planFromCoverage, type PlanNode, type NodeCoverage } from "./highlight-range"

// Pure decision layer for the share-card drag-highlight (no DOM — this repo is
// deliberately node-only for tests, see channel-ref-extension.test.ts:51). The
// error-prone logic (boundary clamp, whole-middle-node, overlap-skip) lives in
// `planHighlight`; the DOM executor (`applyHighlightToRange`) is a thin,
// mechanical layer verified by the PNG render, not unit-tested here.

const n = (length: number, insideMark = false): PlanNode => ({ length, insideMark })

describe("planHighlight", () => {
  it("clamps boundary offsets on the first and last node (partial coverage)", () => {
    // Three 10-char nodes; select from offset 4 of node0 to offset 6 of node2.
    const nodes = [n(10), n(10), n(10)]
    const ops = planHighlight(nodes, { startIdx: 0, startOffset: 4, endIdx: 2, endOffset: 6 })
    expect(ops).toEqual([
      { idx: 0, sliceStart: 4, sliceEnd: 10 }, // first node: from startOffset to end
      { idx: 1, sliceStart: 0, sliceEnd: 10 }, // middle node: whole
      { idx: 2, sliceStart: 0, sliceEnd: 6 },  // last node: start to endOffset
    ])
  })

  it("wraps whole middle nodes entirely", () => {
    const nodes = [n(5), n(8), n(5)]
    const ops = planHighlight(nodes, { startIdx: 0, startOffset: 0, endIdx: 2, endOffset: 5 })
    expect(ops[1]).toEqual({ idx: 1, sliceStart: 0, sliceEnd: 8 })
  })

  it("skips nodes already inside a highlight (no nesting on overlapping drags)", () => {
    // node1 is already highlighted → it must be skipped, node0 + node2 wrapped.
    const nodes = [n(6), n(6, true), n(6)]
    const ops = planHighlight(nodes, { startIdx: 0, startOffset: 0, endIdx: 2, endOffset: 6 })
    expect(ops.map((o) => o.idx)).toEqual([0, 2])
  })

  it("single-node selection wraps just the selected slice", () => {
    const ops = planHighlight([n(20)], { startIdx: 0, startOffset: 5, endIdx: 0, endOffset: 12 })
    expect(ops).toEqual([{ idx: 0, sliceStart: 5, sliceEnd: 12 }])
  })

  it("drops empty / zero-width slices (a boundary offset covering nothing)", () => {
    // End at offset 0 of node1 = node1 contributes nothing; only node0 wraps.
    const nodes = [n(10), n(10)]
    const ops = planHighlight(nodes, { startIdx: 0, startOffset: 0, endIdx: 1, endOffset: 0 })
    expect(ops).toEqual([{ idx: 0, sliceStart: 0, sliceEnd: 10 }])
  })

  it("clamps offsets that exceed node length (defensive)", () => {
    const ops = planHighlight([n(5)], { startIdx: 0, startOffset: 0, endIdx: 0, endOffset: 99 })
    expect(ops).toEqual([{ idx: 0, sliceStart: 0, sliceEnd: 5 }])
  })

  it("returns nothing for an inverted range", () => {
    expect(planHighlight([n(5), n(5)], { startIdx: 1, startOffset: 0, endIdx: 0, endOffset: 5 })).toEqual([])
  })

  it("returns nothing when every covered node is already highlighted", () => {
    const nodes = [n(5, true), n(5, true)]
    expect(planHighlight(nodes, { startIdx: 0, startOffset: 0, endIdx: 1, endOffset: 5 })).toEqual([])
  })
})

// Coverage → plan (the element-boundary decision, previously the broken
// DOM-side `findIdx`). Shelly #334: triple-click a <p> / select-all land BOTH
// range endpoints on elements → every covered text node between first and last
// must be included, not just the first.
const cov = (
  length: number,
  covered: boolean,
  extra?: { insideMark?: boolean; startOffset?: number; endOffset?: number },
): NodeCoverage => ({ length, covered, insideMark: extra?.insideMark ?? false, ...extra })

describe("planFromCoverage", () => {
  it("triple-click a <p>: all three covered text nodes wrap (regression for the boundary bug)", () => {
    // "Hello " / "bold" / " world" — both endpoints on the <p> element, so no
    // per-node startOffset/endOffset; all three are `covered`.
    const nodes = [cov(6, true), cov(4, true), cov(6, true)]
    const ops = planFromCoverage(nodes)
    expect(ops).toEqual([
      { idx: 0, sliceStart: 0, sliceEnd: 6 },
      { idx: 1, sliceStart: 0, sliceEnd: 4 },
      { idx: 2, sliceStart: 0, sliceEnd: 6 },
    ])
  })

  it("select-all: every covered node across blocks wraps", () => {
    const nodes = [cov(5, true), cov(5, true), cov(5, true), cov(5, true)]
    expect(planFromCoverage(nodes).map((o) => o.idx)).toEqual([0, 1, 2, 3])
  })

  it("text-boundary drag: honors per-node start/end offsets, ignores uncovered tail", () => {
    // Drag from offset 2 of node0 through node1 to offset 3 of node2; node3 not covered.
    const nodes = [
      cov(6, true, { startOffset: 2 }),
      cov(4, true),
      cov(6, true, { endOffset: 3 }),
      cov(6, false),
    ]
    expect(planFromCoverage(nodes)).toEqual([
      { idx: 0, sliceStart: 2, sliceEnd: 6 },
      { idx: 1, sliceStart: 0, sliceEnd: 4 },
      { idx: 2, sliceStart: 0, sliceEnd: 3 },
    ])
  })

  it("skips an already-highlighted node in the middle of a select-all", () => {
    const nodes = [cov(5, true), cov(5, true, { insideMark: true }), cov(5, true)]
    expect(planFromCoverage(nodes).map((o) => o.idx)).toEqual([0, 2])
  })

  it("returns nothing when no node is covered", () => {
    expect(planFromCoverage([cov(5, false), cov(5, false)])).toEqual([])
  })

  it("gap in coverage still spans first→last covered (contiguous range assumption)", () => {
    // A real selection is contiguous; if the middle shows uncovered (shouldn't
    // happen), first→last still defines the span and planHighlight wraps the
    // covered ends. Guards the first/last scan logic.
    const nodes = [cov(5, true), cov(5, false), cov(5, true)]
    expect(planFromCoverage(nodes).map((o) => o.idx)).toEqual([0, 1, 2])
  })
})
