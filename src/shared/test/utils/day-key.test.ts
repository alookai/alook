import { describe, it, expect } from "vitest"
import { utcDayKey, utcDayKeyDaysAgo } from "../../src/utils/day-key"

describe("utcDayKey", () => {
  it("returns the UTC YYYY-MM-DD for a Date", () => {
    expect(utcDayKey(new Date("2026-07-31T10:00:00Z"))).toBe("2026-07-31")
  })

  it("accepts an ISO string and an epoch-ms number", () => {
    expect(utcDayKey("2026-07-31T23:59:59Z")).toBe("2026-07-31")
    expect(utcDayKey(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-01-01")
  })

  it("keys by UTC, not local time — an instant late in a UTC day stays that day", () => {
    // 23:30 UTC is the same UTC calendar day regardless of the runner's tz;
    // this is what keeps the handled and sent upserts on the same (botId, day)
    // row for one calendar day (the single-source red line).
    expect(utcDayKey("2026-07-31T23:30:00Z")).toBe("2026-07-31")
    expect(utcDayKey("2026-08-01T00:30:00Z")).toBe("2026-08-01")
  })

  it("is stable for the same instant across call sites (handled vs sent agree)", () => {
    const instant = "2026-07-31T12:34:56Z"
    expect(utcDayKey(instant)).toBe(utcDayKey(new Date(instant)))
  })
})

describe("utcDayKeyDaysAgo", () => {
  it("returns the key N days before, inclusive-window lower bound", () => {
    // 29 days before 2026-07-31 = 2026-07-02 (a 30-day window incl. today).
    expect(utcDayKeyDaysAgo(new Date("2026-07-31T10:00:00Z"), 29)).toBe("2026-07-02")
  })

  it("0 days ago is today", () => {
    expect(utcDayKeyDaysAgo("2026-07-31T10:00:00Z", 0)).toBe("2026-07-31")
  })

  it("crosses month and year boundaries correctly", () => {
    expect(utcDayKeyDaysAgo("2026-01-05T10:00:00Z", 10)).toBe("2025-12-26")
  })

  it("does not mutate the passed Date", () => {
    const d = new Date("2026-07-31T10:00:00Z")
    utcDayKeyDaysAgo(d, 29)
    expect(d.toISOString()).toBe("2026-07-31T10:00:00.000Z")
  })
})
