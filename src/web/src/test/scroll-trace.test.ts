import { describe, expect, it } from "vitest"
import baseline from "./fixtures/message-scroll-baseline.json"
import {
  classifyTracePair,
  coalesceWriterCalls,
  nativeMargin,
  summarizeScrollTrace,
  validateScrollTrace,
  type ScrollTraceFrame,
  type ScrollTraceResult,
  type ScrollTraceWrite,
} from "./e2e-ui/_fixtures/scroll-trace"

function frame(input: Partial<ScrollTraceFrame> & { frame: number; scrollTop: number }): ScrollTraceFrame {
  return {
    timestamp: input.frame * 16,
    scrollHeight: 1000,
    clientHeight: 400,
    browserMax: 600,
    distanceToEnd: 600 - input.scrollTop,
    programmaticScrollInProgress: false,
    scrollerRect: null,
    contentRect: null,
    composerRect: null,
    accessoryRailRect: null,
    tailGap: 0,
    newDividerRect: null,
    loaders: {
      top: { mounted: false, loading: false, rect: null },
      bottom: { mounted: false, loading: false, rect: null },
    },
    pill: { mode: null, count: 0, label: null },
    renderedRange: [0, 2],
    visibleRange: [0, 2],
    firstVisibleId: "m1",
    firstVisibleOffset: 4,
    lastVisibleId: "m3",
    domIds: ["m1", "m2", "m3"],
    rows: [],
    mark: "final-stimulus",
    writerRevision: 0,
    measurementRevision: 0,
    ...input,
  }
}

function result(overrides: Partial<ScrollTraceResult> = {}): ScrollTraceResult {
  return {
    schemaVersion: 1,
    scenario: "upward",
    commandDirection: "backward",
    identity: {
      sourceSha: "a".repeat(40),
      lockHash: "b".repeat(64),
      servedBuildId: "build-1",
      probeHash: "c".repeat(64),
      profileVersion: "message-scroll-v1",
      runtime: "chromium",
      account: "alice",
      channel: "channel-1",
      viewport: { width: 1280, height: 800, dpr: 1 },
    },
    startedAt: 0,
    endedAt: 80,
    status: "stable",
    capabilities: {},
    marks: [{
      timestamp: 0,
      frame: 0,
      name: "final-stimulus",
      dataTransitionSource: null,
      detail: null,
      preEventDistanceToEnd: 0,
      programmaticScrollInProgress: false,
    }],
    frames: [
      frame({ frame: 1, scrollTop: 600 }),
      frame({ frame: 2, scrollTop: 576 }),
      frame({ frame: 3, scrollTop: 580 }),
      frame({ frame: 4, scrollTop: 556, firstVisibleOffset: 3 }),
    ],
    writes: [],
    measurements: [],
    externalEvents: [],
    dropped: { frames: 0, writes: 0 },
    ...overrides,
  }
}

function write(input: Partial<ScrollTraceWrite> = {}): ScrollTraceWrite {
  return {
    timestamp: 1,
    frame: 1,
    method: "scrollTop",
    args: [1],
    mark: "receive",
    fingerprint: "abc",
    stack: "use-scroll-anchor.ts",
    ...input,
  }
}

describe("scroll trace normalization", () => {
  it("accepts explicit stable and timeout results and rejects malformed evidence", () => {
    expect(validateScrollTrace(result())).toEqual([])
    expect(validateScrollTrace(result({ status: "settlementTimedOut" }))).toEqual([])
    expect(validateScrollTrace(result({
      schemaVersion: 2,
      marks: [],
      frames: [frame({ frame: 1, scrollTop: Number.NaN })],
    }))).toEqual(expect.arrayContaining([
      "schema version",
      "final-stimulus mark",
      "non-finite geometry",
    ]))
    expect(validateScrollTrace(result({
      externalEvents: [{ timestamp: 1, type: "cookie", detail: "secret" }],
    }))).toContain("sensitive field")
  })

  it("keeps metric margins in their native units", () => {
    expect(nativeMargin(10, "css-px")).toBe(1)
    expect(nativeMargin(100, "css-px")).toBe(5)
    expect(nativeMargin(21, "count")).toBe(2)
    expect(nativeMargin(4, "ms")).toBe(1)
    expect(nativeMargin(1, "percentage-point")).toBe(0.1)
  })

  it("keeps the committed baseline observational, unit-correct, and free of user data", () => {
    expect(baseline.schemaVersion).toBe(1)
    expect(baseline.capture.successfulMatrixRuns).toBeGreaterThanOrEqual(2)
    expect(baseline.capture.portablePerformanceGate).toBe(false)
    expect(baseline.units.frameDelta).toBe("css-px")
    expect(baseline.units.writerCount).toBe("count")
    expect(baseline.gatePolicy.diagnostic).toEqual(expect.arrayContaining([
      "writer ownership and contention",
      "frame-delta p95 and max",
    ]))
    expect(Object.keys(baseline.observations)).toHaveLength(6)
    expect(JSON.stringify(baseline)).not.toMatch(/account|channel|message(Id|Body)|cookie|authorization/i)
  })
})

describe("scroll trace writers and metrics", () => {
  it("coalesces one logical writer across adjacent microtask and RAF calls", () => {
    const calls = coalesceWriterCalls([
      write({ frame: 4 }),
      write({ frame: 5, method: "scrollTo" }),
      write({ frame: 8, fingerprint: "other", stack: "virtual-core/index.js" }),
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ owner: "scroll-anchor", firstFrame: 4, lastFrame: 5 })
    expect(calls[0]?.calls).toHaveLength(2)
    expect(calls[1]?.owner).toBe("tanstack-virtual")
  })

  it("keeps known product symptoms diagnostic in the summary", () => {
    const summary = summarizeScrollTrace(result({
      status: "settlementTimedOut",
      writes: [
        write({ frame: 2, stack: "use-scroll-anchor.ts" }),
        write({ frame: 2, fingerprint: "unknown", stack: "bundle.js" }),
      ],
      measurements: [
        { timestamp: 1, frame: 1, id: "m1", index: 1, height: 20 },
        { timestamp: 2, frame: 2, id: "m1", index: 1, height: 21 },
      ],
    }))
    expect(summary.status).toBe("settlementTimedOut")
    expect(summary.finalProgress).toBe(-44)
    expect(summary.reversalCount).toBe(0)
    expect(summary.contentionEpochs).toEqual([{
      frame: 2,
      owners: ["scroll-anchor", "unknown:unknown"],
    }])
    expect(summary.unknownWriterCount).toBe(1)
    expect(summary.repeatedMeasurementRows).toEqual([{ id: "m1", count: 2 }])
  })
})

describe("matched Web and Desktop classification", () => {
  it("requires complete identity equality before platform attribution", () => {
    const web = result()
    const desktop = result({
      identity: { ...web.identity, runtime: "tauri", servedBuildId: "other" },
    })
    expect(classifyTracePair(web, desktop)).toEqual({
      classification: "unclassified",
      reasons: ["identity:servedBuildId"],
    })
  })

  it("uses unit-correct count and pixel margins only on matched pairs", () => {
    const web = result()
    const desktop = result({
      identity: { ...web.identity, runtime: "tauri" },
      frames: [
        frame({ frame: 1, scrollTop: 600, firstVisibleOffset: 4 }),
        frame({ frame: 2, scrollTop: 576, firstVisibleOffset: 4 }),
        frame({ frame: 3, scrollTop: 590, firstVisibleOffset: 8 }),
        frame({ frame: 4, scrollTop: 556, firstVisibleOffset: 8 }),
      ],
    })
    expect(classifyTracePair(web, desktop).classification).toBe("platform-regression")
  })
})
