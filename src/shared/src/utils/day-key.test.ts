import { describe, expect, it } from "vitest"
import {
  calendarDayKeyDaysAgo,
  dayKeyInTimeZone,
  utcDayKey,
  utcDayKeyDaysAgo,
} from "./day-key"

describe("day keys", () => {
  it("keeps existing UTC helpers stable", () => {
    expect(utcDayKey("2026-08-29T23:00:00-07:00")).toBe("2026-08-30")
    expect(utcDayKeyDaysAgo("2026-03-01T00:00:00Z", 1)).toBe("2026-02-28")
  })

  it("subtracts literal calendar days across month and leap-year boundaries", () => {
    expect(calendarDayKeyDaysAgo("2026-03-01", 1)).toBe("2026-02-28")
    expect(calendarDayKeyDaysAgo("2024-03-01", 1)).toBe("2024-02-29")
    expect(calendarDayKeyDaysAgo("2026-12-31", -1)).toBe("2027-01-01")
    expect(() => calendarDayKeyDaysAgo("2026-02-30", 1)).toThrow("invalid calendar day key")
  })

  it("formats the same instant in the computer timezone instead of UTC", () => {
    const instant = "2026-08-29T16:00:01Z"
    expect(dayKeyInTimeZone(instant, "Asia/Shanghai")).toBe("2026-08-30")
    expect(dayKeyInTimeZone(instant, "America/Los_Angeles")).toBe("2026-08-29")
  })

  it("keeps seven literal calendar days stable across DST transitions", () => {
    expect(Array.from(
      { length: 7 },
      (_, offset) => calendarDayKeyDaysAgo("2026-03-10", 6 - offset),
    )).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ])
    expect(dayKeyInTimeZone("2026-03-08T09:59:59Z", "America/Los_Angeles")).toBe("2026-03-08")
    expect(dayKeyInTimeZone("2026-03-08T10:00:01Z", "America/Los_Angeles")).toBe("2026-03-08")
    expect(dayKeyInTimeZone("2026-11-01T08:59:59Z", "America/Los_Angeles")).toBe("2026-11-01")
    expect(dayKeyInTimeZone("2026-11-01T09:00:01Z", "America/Los_Angeles")).toBe("2026-11-01")
  })
})
