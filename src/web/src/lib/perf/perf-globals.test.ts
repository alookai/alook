import { describe, it, expect } from "vitest"
import { pushPerfEvent, PERF_RING_MAX, type PerfEventRecord } from "./perf-globals"

function makeEvent(ts: number): PerfEventRecord {
  return { kind: "commit", ts }
}

describe("pushPerfEvent — bounded ring buffer", () => {
  it("allocates the buffer on first push", () => {
    const target: { __ALOOK_PERF__?: PerfEventRecord[] } = {}
    pushPerfEvent(target, makeEvent(1))
    expect(target.__ALOOK_PERF__).toHaveLength(1)
  })

  it("clamps to the max size, dropping oldest", () => {
    const target: { __ALOOK_PERF__?: PerfEventRecord[] } = {}
    for (let i = 0; i < 5; i++) pushPerfEvent(target, makeEvent(i), 3)
    const buf = target.__ALOOK_PERF__!
    expect(buf).toHaveLength(3)
    // oldest (ts 0,1) dropped; newest three retained in order.
    expect(buf.map((e) => e.ts)).toEqual([2, 3, 4])
  })

  it("defaults to PERF_RING_MAX", () => {
    const target: { __ALOOK_PERF__?: PerfEventRecord[] } = {}
    for (let i = 0; i < PERF_RING_MAX + 10; i++) pushPerfEvent(target, makeEvent(i))
    expect(target.__ALOOK_PERF__).toHaveLength(PERF_RING_MAX)
  })
})
