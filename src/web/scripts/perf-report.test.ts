import { describe, it, expect } from "vitest"
import { analyzeSwitch, renderReport } from "./perf-report"
import type { CapturedSwitch, CaptureFile } from "../src/test/e2e-ui/perf/perf-capture-types"

function baseSwitch(over: Partial<CapturedSwitch> = {}): CapturedSwitch {
  return {
    kind: "channel",
    targetId: "chan-1",
    cacheState: "cold",
    clickTs: 1000,
    skeletonTs: 1010,
    paintedTs: 1500,
    contentStableTs: 1600,
    resources: [],
    commits: [],
    unmounts: [],
    layoutShifts: [],
    degraded: false,
    ...over,
  }
}

describe("analyzeSwitch — phases & perceived latency", () => {
  it("computes the three-phase breakdown and perceived total", () => {
    const a = analyzeSwitch(baseSwitch())
    expect(a.perceivedMs).toBe(600) // 1600 - 1000
    expect(a.clickToSkeletonMs).toBe(10)
    expect(a.skeletonToPaintedMs).toBe(490)
    expect(a.paintedToStableMs).toBe(100)
  })

  it("falls back to painted when there is no content-stable anchor", () => {
    const a = analyzeSwitch(baseSwitch({ contentStableTs: null }))
    expect(a.perceivedMs).toBe(500) // painted(1500) - click(1000)
  })
})

describe("analyzeSwitch — serialization verdict", () => {
  it("labels SERIALIZED when read-state response-end precedes messages request-start", () => {
    const a = analyzeSwitch(
      baseSwitch({
        resources: [
          { name: "http://x/api/community/channels/c/read-state", startTime: 1010, responseEnd: 1300 },
          { name: "http://x/api/community/channels/c/messages", startTime: 1305, responseEnd: 1580 },
        ],
      }),
    )
    expect(a.readStateBlocksMessages).toBe(true)
    expect(a.verdict).toMatch(/SERIALIZED/)
  })

  it("labels parallel when read-state and messages overlap", () => {
    const a = analyzeSwitch(
      baseSwitch({
        resources: [
          { name: "http://x/api/community/channels/c/read-state", startTime: 1010, responseEnd: 1400 },
          { name: "http://x/api/community/channels/c/messages", startTime: 1050, responseEnd: 1580 },
        ],
      }),
    )
    expect(a.readStateBlocksMessages).toBe(false)
  })
})

describe("analyzeSwitch — non-network attribution", () => {
  it("blames render/remount/reflow when network is a small slice", () => {
    // 600ms perceived, but only ~30ms of network.
    const a = analyzeSwitch(
      baseSwitch({
        resources: [
          { name: "http://x/api/community/channels/c/read-state", startTime: 1010, responseEnd: 1025 },
          { name: "http://x/api/community/channels/c/messages", startTime: 1025, responseEnd: 1040 },
        ],
        unmounts: ["ChannelView"],
        commits: [
          {
            ts: 1050,
            kind: "commit",
            mounts: [{ name: "ChannelView", fiberId: 1, actualDuration: 5 }],
            rerenders: [],
          },
        ],
      }),
    )
    expect(a.verdict).toMatch(/NOT network-bound/)
    expect(a.networkMs).toBeLessThan(a.perceivedMs! * 0.6)
  })
})

describe("analyzeSwitch — mount de-echo (ring-buffer dedup)", () => {
  it("dedups mounts by fiberId regardless of how many commits re-report them", () => {
    // react-scan re-reports every still-mounted fiber on each later commit, so
    // the same first-mount fiber appears once per subsequent commit. The naive
    // total is inflated; deduping by fiberId recovers the true count. Here two
    // fibers are echoed across three commits (2 raw each → 6 raw), but only 2
    // components actually mounted.
    const echo = [
      { name: "ChannelView", fiberId: 7, actualDuration: 3 },
      { name: "MessageList", fiberId: 8, actualDuration: 2 },
    ]
    const a = analyzeSwitch(
      baseSwitch({
        commits: [
          { ts: 1050, kind: "commit", mounts: [...echo], rerenders: [] },
          { ts: 1080, kind: "commit", mounts: [...echo], rerenders: [] },
          { ts: 1120, kind: "commit", mounts: [...echo], rerenders: [] },
        ],
      }),
    )
    expect(a.mountCountRaw).toBe(6)
    expect(a.mountCountUnique).toBe(2)
  })

  it("counts id-less mounts individually (cannot dedup a missing id)", () => {
    const a = analyzeSwitch(
      baseSwitch({
        commits: [
          {
            ts: 1050,
            kind: "commit",
            mounts: [
              { name: "A", fiberId: 1, actualDuration: 1 },
              { name: "Anon", actualDuration: 1 },
              { name: "Anon", actualDuration: 1 },
            ],
            rerenders: [],
          },
        ],
      }),
    )
    expect(a.mountCountRaw).toBe(3)
    expect(a.mountCountUnique).toBe(3) // 1 unique id + 2 id-less
  })
})

describe("analyzeSwitch — re-renders are genuine (not deduped away)", () => {
  it("keeps every re-render in raw but counts distinct components in unique", () => {
    // Root re-renders across 3 commits — 3 genuine renders, 1 distinct component.
    const a = analyzeSwitch(
      baseSwitch({
        commits: [
          { ts: 1050, kind: "commit", mounts: [], rerenders: [{ name: "Root", fiberId: 3, actualDuration: 5 }] },
          { ts: 1080, kind: "commit", mounts: [], rerenders: [{ name: "Root", fiberId: 3, actualDuration: 4 }] },
          { ts: 1120, kind: "commit", mounts: [], rerenders: [{ name: "Root", fiberId: 3, actualDuration: 6 }] },
        ],
      }),
    )
    expect(a.rerenderCountRaw).toBe(3)
    expect(a.rerenderCountUnique).toBe(1)
  })
})

describe("renderReport — cache-state split", () => {
  it("emits a section per switch across cache states", () => {
    const file: CaptureFile = {
      owner: { email: "perf-seed@alook.test", userId: "u1" },
      createdAt: "2026-07-24T00:00:00.000Z",
      switches: [
        baseSwitch({ cacheState: "cold" }),
        baseSwitch({ cacheState: "memory-warm" }),
        baseSwitch({ cacheState: "disk-warm" }),
      ],
    }
    const md = renderReport(file)
    expect(md).toMatch(/cache: cold/)
    expect(md).toMatch(/cache: memory-warm/)
    expect(md).toMatch(/cache: disk-warm/)
    expect(md).toMatch(/PERCEIVED/)
  })
})
