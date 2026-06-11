import { describe, it, expect, vi } from "vitest";
import * as calendarQueries from "../../src/db/queries/calendar-event";

describe("calendar-event query module exports", () => {
  it("exports createCalendarEvent", () => {
    expect(typeof calendarQueries.createCalendarEvent).toBe("function");
  });
  it("exports listCalendarEvents", () => {
    expect(typeof calendarQueries.listCalendarEvents).toBe("function");
  });
  it("exports getCalendarEvent", () => {
    expect(typeof calendarQueries.getCalendarEvent).toBe("function");
  });
  it("exports deleteCalendarEvent", () => {
    expect(typeof calendarQueries.deleteCalendarEvent).toBe("function");
  });
  it("exports updateCalendarEvent", () => {
    expect(typeof calendarQueries.updateCalendarEvent).toBe("function");
  });

  // Compile-time guard: patch accepts optional title and nullable description.
  // Kept inside an `if (false)` block so the runtime path is never exercised,
  // but the TypeScript compiler still checks the call signature.
  it("has a patch-shaped signature (type-level)", () => {
    if (false) {
      const db = {} as Parameters<typeof calendarQueries.updateCalendarEvent>[0];
      void calendarQueries.updateCalendarEvent(db, "ce_1", "ws_1", {
        title: "t",
        description: null,
      });
      void calendarQueries.updateCalendarEvent(db, "ce_1", "ws_1", {
        title: "t",
      });
      void calendarQueries.updateCalendarEvent(db, "ce_1", "ws_1", {
        description: "x",
      });
      void calendarQueries.updateCalendarEvent(db, "ce_1", "ws_1", {
        description: undefined,
      });
      void calendarQueries.updateCalendarEvent(db, "ce_1", "ws_1", {
        agentId: "ag_2",
        scheduledAt: "2026-05-01T12:00:00.000Z",
        repeatInterval: null,
        repeatStopAt: null,
      });
    }
    expect(true).toBe(true);
  });
  it("exports listDueCalendarEvents", () => {
    expect(typeof calendarQueries.listDueCalendarEvents).toBe("function");
  });
  it("exports claimCalendarEvent", () => {
    expect(typeof calendarQueries.claimCalendarEvent).toBe("function");
  });
  it("exports revertCalendarEventClaim", () => {
    expect(typeof calendarQueries.revertCalendarEventClaim).toBe("function");
  });
  it("exports updateCalendarEventSchedule", () => {
    expect(typeof calendarQueries.updateCalendarEventSchedule).toBe("function");
  });
  it("exports addRepeatInterval", () => {
    expect(typeof calendarQueries.addRepeatInterval).toBe("function");
  });
  it("exports computeNextScheduledAt", () => {
    expect(typeof calendarQueries.computeNextScheduledAt).toBe("function");
  });
});

describe("addRepeatInterval", () => {
  const base = new Date("2026-01-15T10:00:00.000Z");

  it("advances by minutes", () => {
    const out = calendarQueries.addRepeatInterval(base, "30min");
    expect(out.toISOString()).toBe("2026-01-15T10:30:00.000Z");
  });

  it("advances by hours", () => {
    const out = calendarQueries.addRepeatInterval(base, "2hour");
    expect(out.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("advances by days", () => {
    const out = calendarQueries.addRepeatInterval(base, "1day");
    expect(out.toISOString()).toBe("2026-01-16T10:00:00.000Z");
  });

  it("advances by weeks (7 days)", () => {
    const out = calendarQueries.addRepeatInterval(base, "1week");
    expect(out.toISOString()).toBe("2026-01-22T10:00:00.000Z");
  });

  it("advances by months", () => {
    const out = calendarQueries.addRepeatInterval(base, "1month");
    expect(out.toISOString()).toBe("2026-02-15T10:00:00.000Z");
  });

  it("clamps month overflow: Jan 31 + 1 month = Feb 28", () => {
    const jan31 = new Date("2026-01-31T09:00:00.000Z");
    const out = calendarQueries.addRepeatInterval(jan31, "1month");
    // 2026 is not a leap year → Feb has 28 days
    expect(out.getUTCFullYear()).toBe(2026);
    expect(out.getUTCMonth()).toBe(1); // Feb
    expect(out.getUTCDate()).toBe(28);
  });

  it("clamps month overflow: Jan 31 + 1 month in a leap year = Feb 29", () => {
    const jan31 = new Date("2028-01-31T09:00:00.000Z");
    const out = calendarQueries.addRepeatInterval(jan31, "1month");
    expect(out.getUTCFullYear()).toBe(2028);
    expect(out.getUTCMonth()).toBe(1); // Feb
    expect(out.getUTCDate()).toBe(29);
  });

  it("advances across year boundary", () => {
    const dec = new Date("2026-12-15T10:00:00.000Z");
    const out = calendarQueries.addRepeatInterval(dec, "1month");
    expect(out.getUTCFullYear()).toBe(2027);
    expect(out.getUTCMonth()).toBe(0);
  });

  it("throws on invalid format", () => {
    expect(() =>
      calendarQueries.addRepeatInterval(base, "nope")
    ).toThrow();
    expect(() =>
      calendarQueries.addRepeatInterval(base, "1year")
    ).toThrow();
  });
});

describe("computeNextScheduledAt", () => {
  it("returns the next occurrence when the next future occurrence is after now", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      null,
      "2026-01-01T09:30:00.000Z"
    );
    expect(out).toBe("2026-01-02T09:00:00.000Z");
  });

  it("loop-advances past now when daemon downtime missed multiple occurrences", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      null,
      "2026-01-05T09:30:00.000Z"
    );
    // Next must be > now; after four days of downtime, the next tick is Jan 6.
    expect(out).toBe("2026-01-06T09:00:00.000Z");
  });

  it("returns null when the next occurrence would exceed repeat_stop_at", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      "2026-01-01T23:59:59.999Z",
      "2026-01-01T09:30:00.000Z"
    );
    expect(out).toBeNull();
  });

  it("returns null when downtime pushes next past repeat_stop_at (event becomes inert)", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      "2026-01-03T23:59:59.999Z",
      "2026-01-10T09:30:00.000Z"
    );
    expect(out).toBeNull();
  });

  it("fires at the repeat_stop boundary when the next computed occurrence is still <= stop", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      "2026-01-02T23:59:59.999Z",
      "2026-01-01T09:30:00.000Z"
    );
    // Jan 2 at 09:00 is still <= stop
    expect(out).toBe("2026-01-02T09:00:00.000Z");
  });

  it("skips excepted occurrences", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      null,
      "2026-01-01T09:30:00.000Z",
      ["2026-01-02T09:00:00.000Z"]
    );
    expect(out).toBe("2026-01-03T09:00:00.000Z");
  });

  it("skips multiple consecutive exceptions", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      null,
      "2026-01-01T09:30:00.000Z",
      [
        "2026-01-02T09:00:00.000Z",
        "2026-01-03T09:00:00.000Z",
        "2026-01-04T09:00:00.000Z",
      ]
    );
    expect(out).toBe("2026-01-05T09:00:00.000Z");
  });

  it("returns null when all remaining occurrences until stop are excepted", () => {
    const out = calendarQueries.computeNextScheduledAt(
      "2026-01-01T09:00:00.000Z",
      "1day",
      "2026-01-02T23:59:59.999Z",
      "2026-01-01T09:30:00.000Z",
      ["2026-01-02T09:00:00.000Z"]
    );
    expect(out).toBeNull();
  });
});

describe("getOccurrencesPerDay", () => {
  it("returns 1 for daily interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("1day")).toBe(1);
  });

  it("returns 1 for weekly interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("1week")).toBe(1);
  });

  it("returns 1 for monthly interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("1month")).toBe(1);
  });

  it("returns 24 for hourly interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("1hour")).toBe(24);
  });

  it("returns 12 for 2-hour interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("2hour")).toBe(12);
  });

  it("returns 48 for 30-minute interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("30min")).toBe(48);
  });

  it("returns 96 for 15-minute interval", () => {
    expect(calendarQueries.getOccurrencesPerDay("15min")).toBe(96);
  });

  it("returns 1 for invalid format", () => {
    expect(calendarQueries.getOccurrencesPerDay("invalid")).toBe(1);
  });

  it("returns 1 for 0-amount (division guard)", () => {
    expect(calendarQueries.getOccurrencesPerDay("0min")).toBe(1);
  });
});

describe("listCalendarEvents — completed one-off exclusion", () => {
  function createMockDb(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => Promise.resolve(rows));
    chain.innerJoin = vi.fn(() => chain);
    return chain;
  }

  it("calls where() with conditions that would exclude completed one-off events", async () => {
    const db = createMockDb([]);
    await calendarQueries.listCalendarEvents(db, "ws_1");
    expect(db.where).toHaveBeenCalledOnce();
  });

  it("returns all rows from the database (filter logic is in SQL)", async () => {
    const rows = [
      { id: "ce_1", repeatInterval: null, lastTriggeredAt: null },
      { id: "ce_2", repeatInterval: "1day", lastTriggeredAt: "2026-01-01T10:00:00.000Z" },
    ];
    const db = createMockDb(rows);
    const result = await calendarQueries.listCalendarEvents(db, "ws_1");
    expect(result).toEqual(rows);
  });

  it("passes agentId filter when provided", async () => {
    const db = createMockDb([]);
    await calendarQueries.listCalendarEvents(db, "ws_1", { agentId: "ag_1" });
    expect(db.where).toHaveBeenCalledOnce();
  });

  it("uses innerJoin when userId is provided", async () => {
    const ce = { id: "ce_1", agentId: "ag_1", workspaceId: "ws_1", title: "T", description: null, scheduledAt: "2026-01-01T09:00:00.000Z", repeatInterval: null, repeatStopAt: null, lastTriggeredAt: null, exceptions: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const db = createMockDb([{ calendarEvent: ce }]);
    const result = await calendarQueries.listCalendarEvents(db, "ws_1", { userId: "u1" });
    expect(db.innerJoin).toHaveBeenCalledOnce();
    expect(result).toEqual([ce]);
  });

  it("does not use innerJoin when userId is not provided", async () => {
    const db = createMockDb([]);
    await calendarQueries.listCalendarEvents(db, "ws_1");
    expect(db.innerJoin).not.toHaveBeenCalled();
  });
});

describe("getCalendarEvent — user isolation", () => {
  function createMockDb(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    chain.innerJoin = vi.fn(() => chain);
    return chain;
  }

  it("returns event without userId (backwards compat)", async () => {
    const ce = { id: "ce_1" };
    const db = createMockDb([ce]);
    const result = await calendarQueries.getCalendarEvent(db, "ce_1", "ws_1");
    expect(result).toEqual(ce);
    expect(db.innerJoin).not.toHaveBeenCalled();
  });

  it("uses innerJoin when userId is provided", async () => {
    const ce = { id: "ce_1" };
    const db = createMockDb([{ calendarEvent: ce }]);
    const result = await calendarQueries.getCalendarEvent(db, "ce_1", "ws_1", "u1");
    expect(db.innerJoin).toHaveBeenCalledOnce();
    expect(result).toEqual(ce);
  });

  it("returns null when userId does not match (empty rows from join)", async () => {
    const db = createMockDb([]);
    const result = await calendarQueries.getCalendarEvent(db, "ce_1", "ws_1", "wrong_user");
    expect(result).toBeNull();
  });
});

describe("expandOccurrences", () => {
  it("returns one entry per occurrence within [from, to] for a daily event", () => {
    const out = calendarQueries.expandOccurrences(
      "2026-04-17T09:00:00.000Z",
      "1day",
      null,
      [],
      "2026-04-15T00:00:00.000Z",
      "2026-04-20T23:59:59.999Z"
    );
    expect(out).toEqual([
      "2026-04-17T09:00:00.000Z",
      "2026-04-18T09:00:00.000Z",
      "2026-04-19T09:00:00.000Z",
      "2026-04-20T09:00:00.000Z",
    ]);
  });

  it("skips exceptions", () => {
    const out = calendarQueries.expandOccurrences(
      "2026-04-17T09:00:00.000Z",
      "1day",
      null,
      ["2026-04-19T09:00:00.000Z"],
      "2026-04-15T00:00:00.000Z",
      "2026-04-20T23:59:59.999Z"
    );
    expect(out).toEqual([
      "2026-04-17T09:00:00.000Z",
      "2026-04-18T09:00:00.000Z",
      "2026-04-20T09:00:00.000Z",
    ]);
  });

  it("stops at repeat_stop_at", () => {
    const out = calendarQueries.expandOccurrences(
      "2026-04-17T09:00:00.000Z",
      "1day",
      "2026-04-18T23:59:59.999Z",
      [],
      "2026-04-15T00:00:00.000Z",
      "2026-04-30T23:59:59.999Z"
    );
    expect(out).toEqual([
      "2026-04-17T09:00:00.000Z",
      "2026-04-18T09:00:00.000Z",
    ]);
  });

  it("excludes occurrences before `from`", () => {
    const out = calendarQueries.expandOccurrences(
      "2026-04-10T09:00:00.000Z",
      "1day",
      null,
      [],
      "2026-04-12T00:00:00.000Z",
      "2026-04-14T23:59:59.999Z"
    );
    expect(out).toEqual([
      "2026-04-12T09:00:00.000Z",
      "2026-04-13T09:00:00.000Z",
      "2026-04-14T09:00:00.000Z",
    ]);
  });
});
