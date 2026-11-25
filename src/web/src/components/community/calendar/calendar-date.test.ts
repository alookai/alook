import { describe, expect, it } from "vitest"
import {
  combineLocalDateAndTime,
  formatWeekRangeLabel,
  getWeekDays,
  groupOccurrencesByDay,
  layoutDayOccurrences,
  localDayKey,
  startOfWeek,
} from "./calendar-date"
import type { CalendarOccurrenceItem } from "./calendar-types"

function makeOccurrence(
  id: string,
  startIso: string,
  endIso?: string,
): CalendarOccurrenceItem {
  return {
    occurrenceKey: `${id}:${startIso}`,
    eventId: id,
    startAt: startIso,
    endAt: endIso ?? null,
    event: {
      id,
      title: `Event ${id}`,
      creator: { id: "bot_1", name: "Alli", kind: "bot" },
      startAt: startIso,
      durationMinutes: 30,
      endAt: endIso ?? null,
      timeZone: "UTC",
      recurrence: { recurring: false, label: "One-time" },
      sourceMessage: { messageId: "msg_1", accessible: true },
    },
  }
}

describe("calendar-date", () => {
  it("computes Monday-first week days across a month boundary", () => {
    const wed = new Date(2026, 10, 25)
    const monday = startOfWeek(wed, 1)
    expect(localDayKey(monday)).toBe("2026-11-23")

    const days = getWeekDays(new Date(2026, 11, 2), 1)
    expect(days.map(localDayKey)).toEqual([
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
      "2026-12-06",
    ])
    expect(formatWeekRangeLabel(days)).toContain("2026")
  })

  it("assigns side-by-side columns to overlapping day occurrences", () => {
    const day = new Date(2026, 10, 25)
    const a = makeOccurrence(
      "a",
      new Date(2026, 10, 25, 9, 0).toISOString(),
      new Date(2026, 10, 25, 10, 0).toISOString(),
    )
    const b = makeOccurrence(
      "b",
      new Date(2026, 10, 25, 9, 30).toISOString(),
      new Date(2026, 10, 25, 10, 30).toISOString(),
    )
    const c = makeOccurrence(
      "c",
      new Date(2026, 10, 25, 11, 0).toISOString(),
      new Date(2026, 10, 25, 11, 30).toISOString(),
    )

    const laid = layoutDayOccurrences([b, c, a], day, 60)
    const byId = new Map(laid.map((block) => [block.item.eventId, block]))
    expect(byId.get("a")?.columnCount).toBe(2)
    expect(byId.get("b")?.columnCount).toBe(2)
    expect(byId.get("a")?.column).not.toBe(byId.get("b")?.column)
    expect(byId.get("c")?.columnCount).toBe(1)
    expect(byId.get("c")?.column).toBe(0)
  })

  it("groups occurrences chronologically by local day", () => {
    const d1 = makeOccurrence("1", new Date(2026, 10, 26, 14, 0).toISOString())
    const d2 = makeOccurrence("2", new Date(2026, 10, 25, 9, 0).toISOString())
    const d3 = makeOccurrence("3", new Date(2026, 10, 25, 15, 0).toISOString())

    const groups = groupOccurrencesByDay([d1, d3, d2])
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-11-25", "2026-11-26"])
    expect(groups[0]?.items.map((item) => item.eventId)).toEqual(["2", "3"])
  })

  it("combines local date and HH:mm time safely", () => {
    const combined = combineLocalDateAndTime(new Date(2026, 10, 25), "14:45")
    expect(combined.getFullYear()).toBe(2026)
    expect(combined.getMonth()).toBe(10)
    expect(combined.getDate()).toBe(25)
    expect(combined.getHours()).toBe(14)
    expect(combined.getMinutes()).toBe(45)
  })
})
