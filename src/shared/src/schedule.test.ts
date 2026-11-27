import { describe, expect, it } from "vitest"
import {
  advanceNextRunAfterFire,
  computeFirstOccurrenceMs,
  computeNextOccurrenceAfter,
  expandScheduleOccurrences,
  isValidIanaTimeZone,
  zonedDateTimeToUtcMs,
} from "./schedule"

describe("schedule recurrence and timezone math", () => {
  it("validates IANA timezones", () => {
    expect(isValidIanaTimeZone("Asia/Shanghai")).toBe(true)
    expect(isValidIanaTimeZone("America/New_York")).toBe(true)
    expect(isValidIanaTimeZone("UTC")).toBe(true)
    expect(isValidIanaTimeZone("Not/A_Zone")).toBe(false)
    expect(isValidIanaTimeZone("")).toBe(false)
  })

  it("handles one-time events cleanly", () => {
    const startAtMs = Date.parse("2026-11-26T01:00:00.000Z")
    expect(computeFirstOccurrenceMs({ startAtMs, timeZone: "Asia/Shanghai", recurrence: null })).toBe(startAtMs)
    expect(computeNextOccurrenceAfter({ startAtMs, timeZone: "Asia/Shanghai", recurrence: null }, startAtMs, 1)).toBeNull()

    const occs = expandScheduleOccurrences(
      {
        id: "sch_1",
        startAtMs,
        durationMinutes: 30,
        timeZone: "Asia/Shanghai",
        recurrence: null,
      },
      Date.parse("2026-11-25T00:00:00.000Z"),
      Date.parse("2026-11-27T00:00:00.000Z"),
    )
    expect(occs).toEqual([
      {
        eventId: "sch_1",
        occurrenceKey: "sch_1:2026-11-26T01:00:00.000Z",
        startAt: "2026-11-26T01:00:00.000Z",
        endAt: "2026-11-26T01:30:00.000Z",
        runStatus: "scheduled",
      },
    ])
  })

  it("preserves local wall clock across US spring-forward and fall-back DST transitions", () => {
    const beforeSpring = Date.parse("2026-03-07T14:00:00.000Z")
    const afterSpring = computeNextOccurrenceAfter(
      { startAtMs: beforeSpring, timeZone: "America/New_York", recurrence: { freq: "daily", interval: 1 } },
      beforeSpring,
      1,
    )
    expect(new Date(afterSpring!).toISOString()).toBe("2026-03-08T13:00:00.000Z")

    const beforeFall = Date.parse("2026-10-31T13:00:00.000Z")
    const afterFall = computeNextOccurrenceAfter(
      { startAtMs: beforeFall, timeZone: "America/New_York", recurrence: { freq: "daily", interval: 1 } },
      beforeFall,
      1,
    )
    expect(new Date(afterFall!).toISOString()).toBe("2026-11-01T14:00:00.000Z")

    const gapUtc = zonedDateTimeToUtcMs(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      "America/New_York",
    )
    expect(new Date(gapUtc).toISOString()).toBe("2026-03-08T07:30:00.000Z")
  })

  it("expands weekly byWeekday and aligns first occurrence", () => {
    const startAtMs = Date.parse("2026-11-24T09:00:00.000Z")
    const spec = {
      startAtMs,
      timeZone: "UTC",
      recurrence: { freq: "weekly" as const, interval: 1, byWeekday: [1, 3, 5] },
    }
    const first = computeFirstOccurrenceMs(spec)
    expect(new Date(first!).toISOString()).toBe("2026-11-25T09:00:00.000Z")

    const occs = expandScheduleOccurrences(
      { id: "sch_w", ...spec, durationMinutes: 45 },
      Date.parse("2026-11-24T00:00:00.000Z"),
      Date.parse("2026-12-03T00:00:00.000Z"),
    )
    expect(occs.map((o) => o.startAt)).toEqual([
      "2026-11-25T09:00:00.000Z",
      "2026-11-27T09:00:00.000Z",
      "2026-11-30T09:00:00.000Z",
      "2026-12-02T09:00:00.000Z",
    ])
  })

  it("clamps monthly anchor day 31 across short months and restores 31 in March", () => {
    const startAtMs = Date.parse("2026-01-31T01:00:00.000Z")
    const spec = {
      startAtMs,
      timeZone: "Asia/Shanghai",
      recurrence: { freq: "monthly" as const, interval: 1 },
    }
    const feb = computeNextOccurrenceAfter(spec, startAtMs, 1)
    expect(new Date(feb!).toISOString()).toBe("2026-02-28T01:00:00.000Z")
    const mar = computeNextOccurrenceAfter(spec, feb!, 2)
    expect(new Date(mar!).toISOString()).toBe("2026-03-31T01:00:00.000Z")
  })

  it("enforces count and untilAt and fast-forwards missed windows without storms", () => {
    const startAtMs = Date.parse("2026-01-01T00:00:00.000Z")
    const spec = {
      startAtMs,
      timeZone: "UTC",
      recurrence: { freq: "hourly" as const, interval: 2, count: 100 },
    }
    const advanced = advanceNextRunAfterFire(spec, startAtMs, 1, Date.parse("2026-01-01T10:30:00.000Z"))
    expect(new Date(advanced.nextRunAtMs!).toISOString()).toBe("2026-01-01T12:00:00.000Z")
    expect(advanced.occurrenceCount).toBe(6)

    const capped = computeNextOccurrenceAfter(
      {
        startAtMs,
        timeZone: "UTC",
        recurrence: { freq: "daily", interval: 1, untilAt: "2026-01-02T00:00:00.000Z" },
      },
      Date.parse("2026-01-02T00:00:00.000Z"),
      2,
    )
    expect(capped).toBeNull()
  })

  it("fast-forwards multi-year recurring events to a recent week window cleanly", () => {
    const startAtMs = Date.parse("2020-01-01T09:00:00.000Z")
    const occs = expandScheduleOccurrences(
      {
        id: "sch_old",
        startAtMs,
        durationMinutes: 30,
        timeZone: "UTC",
        recurrence: { freq: "daily", interval: 1 },
      },
      Date.parse("2026-11-25T00:00:00.000Z"),
      Date.parse("2026-11-28T00:00:00.000Z"),
      new Map([[Date.parse("2026-11-25T09:00:00.000Z"), "dispatched"]]),
    )
    expect(occs.map((o) => [o.startAt, o.runStatus])).toEqual([
      ["2026-11-25T09:00:00.000Z", "dispatched"],
      ["2026-11-26T09:00:00.000Z", "scheduled"],
      ["2026-11-27T09:00:00.000Z", "scheduled"],
    ])
  })
})
