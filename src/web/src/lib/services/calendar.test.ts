import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockListDue = vi.fn();
const mockClaim = vi.fn();
const mockRevert = vi.fn();
const mockUpdateSchedule = vi.fn();
const mockGetAgent = vi.fn();
const mockGetUser = vi.fn();
const mockCreateConv = vi.fn();
const mockCreateMessage = vi.fn();
const mockCreateTask = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAgent: (...args: unknown[]) => mockGetAgent(...args) },
      user: { getUserSelf: (...args: unknown[]) => mockGetUser(...args) },
      conversation: {
        createConversation: (...args: unknown[]) => mockCreateConv(...args),
      },
      message: {
        createMessage: (...args: unknown[]) => mockCreateMessage(...args),
      },
      task: { createTask: (...args: unknown[]) => mockCreateTask(...args) },
      calendarEvent: {
        listDueCalendarEvents: (...args: unknown[]) => mockListDue(...args),
        claimCalendarEvent: (...args: unknown[]) => mockClaim(...args),
        revertCalendarEventClaim: (...args: unknown[]) => mockRevert(...args),
        updateCalendarEventSchedule: (...args: unknown[]) =>
          mockUpdateSchedule(...args),
        computeNextScheduledAt: actual.queries.calendarEvent
          .computeNextScheduledAt,
      },
    },
  };
});

import {
  promoteDueCalendarEventsForWorkspace,
  repeatStopDateToStopAt,
} from "./calendar";

const fakeDb = {} as never;

function mkEvent(over?: Partial<Record<string, unknown>>) {
  return {
    id: "ce_1",
    agentId: "ag_1",
    workspaceId: "ws_1",
    title: "Run standup",
    scheduledAt: "2026-04-17T09:00:00.000Z",
    repeatInterval: null,
    repeatStopAt: null,
    lastTriggeredAt: null,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ id: "u_1", name: "Gus", email: "gus@memodb.io" });
});

describe("promoteDueCalendarEventsForWorkspace", () => {
  it("promotes a due event: claim succeeds → conversation + task created", async () => {
    mockListDue.mockResolvedValue([mkEvent()]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    const enqueued = await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:05:00.000Z"
    );

    expect(enqueued).toBe(1);
    expect(mockCreateConv).toHaveBeenCalledTimes(1);
    expect(mockCreateConv.mock.calls[0][1]).toMatchObject({
      workspaceId: "ws_1",
      agentId: "ag_1",
      userId: "u_1",
      type: "calendar_event",
    });
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "event" }),
    );
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockCreateTask.mock.calls[0][1]).toMatchObject({
      agentId: "ag_1",
      runtimeId: "rt_1",
      workspaceId: "ws_1",
      conversationId: "cv_1",
      prompt: "Run standup",
      type: "calendar_event",
    });
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it("skips events without a runtime — no writes issued (stays eligible)", async () => {
    mockListDue.mockResolvedValue([mkEvent()]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: null,
      ownerId: "u_1",
    });

    const enqueued = await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:05:00.000Z"
    );
    expect(enqueued).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockCreateConv).not.toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("skips events without an owner — no writes issued", async () => {
    mockListDue.mockResolvedValue([mkEvent()]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: null,
    });

    const enqueued = await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:05:00.000Z"
    );
    expect(enqueued).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("concurrent callers: only one enqueues because the guarded UPDATE fails the second time", async () => {
    // Both callers see the same candidate list, but the second claim fails.
    mockListDue.mockResolvedValue([mkEvent()]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim
      .mockResolvedValueOnce({ id: "ce_1" })
      .mockResolvedValueOnce(null);
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    const [a, b] = await Promise.all([
      promoteDueCalendarEventsForWorkspace(fakeDb, "ws_1", "2026-04-17T09:05:00.000Z"),
      promoteDueCalendarEventsForWorkspace(fakeDb, "ws_1", "2026-04-17T09:05:00.000Z"),
    ]);

    expect(a + b).toBe(1);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockCreateConv).toHaveBeenCalledTimes(1);
  });

  it("reverts last_triggered_at when task insert fails after claim", async () => {
    mockListDue.mockResolvedValue([mkEvent({ lastTriggeredAt: null })]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockRejectedValue(new Error("D1 write failed"));

    const enqueued = await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:05:00.000Z"
    );

    expect(enqueued).toBe(0);
    expect(mockRevert).toHaveBeenCalledTimes(1);
    expect(mockRevert.mock.calls[0]).toMatchObject({ "1": "ce_1", "2": null });
  });

  it("reverts to the previous last_triggered_at value (not null)", async () => {
    mockListDue.mockResolvedValue([
      mkEvent({
        scheduledAt: "2026-04-17T09:00:00.000Z",
        lastTriggeredAt: "2026-04-16T09:00:00.000Z",
      }),
    ]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockRejectedValue(new Error("fail"));

    await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:05:00.000Z"
    );

    expect(mockRevert).toHaveBeenCalledWith(
      fakeDb,
      "ce_1",
      "2026-04-16T09:00:00.000Z"
    );
  });

  it("advances the schedule for repeating events after a successful enqueue", async () => {
    mockListDue.mockResolvedValue([
      mkEvent({
        scheduledAt: "2026-04-17T09:00:00.000Z",
        repeatInterval: "1day",
      }),
    ]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:30:00.000Z"
    );

    expect(mockUpdateSchedule).toHaveBeenCalledWith(
      fakeDb,
      "ce_1",
      "2026-04-18T09:00:00.000Z"
    );
  });

  it("passes description and scheduled_by in task context when both exist", async () => {
    mockListDue.mockResolvedValue([mkEvent({ description: "Check PRs" })]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    await promoteDueCalendarEventsForWorkspace(fakeDb, "ws_1", "2026-04-17T09:05:00.000Z");

    expect(mockCreateTask.mock.calls[0][1].contextKey).toBe("cv_1");
    expect(mockCreateTask.mock.calls[0][1].context).toEqual({
      event_id: "ce_1",
      datetime: "2026-04-17T09:00:00.000Z",
      is_recurring: false,
      repeat_interval: null,
      description: "Check PRs",
      scheduled_by: { name: "Gus", email: "gus@memodb.io" },
    });
  });

  it("omits description from task context when event has no description", async () => {
    mockListDue.mockResolvedValue([mkEvent({ description: null })]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    await promoteDueCalendarEventsForWorkspace(fakeDb, "ws_1", "2026-04-17T09:05:00.000Z");

    const ctx = mockCreateTask.mock.calls[0][1].context;
    expect(ctx.event_id).toBe("ce_1");
    expect(ctx.datetime).toBe("2026-04-17T09:00:00.000Z");
    expect(ctx.is_recurring).toBe(false);
    expect(ctx.repeat_interval).toBeNull();
    expect(ctx.description).toBeUndefined();
    expect(ctx.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
  });

  it("omits scheduled_by from task context when getUser returns null", async () => {
    mockListDue.mockResolvedValue([mkEvent({ description: "Check PRs" })]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_deleted",
    });
    mockGetUser.mockResolvedValue(null);
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    await promoteDueCalendarEventsForWorkspace(fakeDb, "ws_1", "2026-04-17T09:05:00.000Z");

    const ctx = mockCreateTask.mock.calls[0][1].context;
    expect(ctx.event_id).toBe("ce_1");
    expect(ctx.datetime).toBe("2026-04-17T09:00:00.000Z");
    expect(ctx.is_recurring).toBe(false);
    expect(ctx.repeat_interval).toBeNull();
    expect(ctx.description).toBe("Check PRs");
    expect(ctx.scheduled_by).toBeUndefined();
  });

  it("includes is_recurring=true and repeat_interval for recurring events", async () => {
    mockListDue.mockResolvedValue([
      mkEvent({ repeatInterval: "1week", description: null }),
    ]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    await promoteDueCalendarEventsForWorkspace(fakeDb, "ws_1", "2026-04-17T09:05:00.000Z");

    const ctx = mockCreateTask.mock.calls[0][1].context;
    expect(ctx.event_id).toBe("ce_1");
    expect(ctx.datetime).toBe("2026-04-17T09:00:00.000Z");
    expect(ctx.is_recurring).toBe(true);
    expect(ctx.repeat_interval).toBe("1week");
  });

  it("does not advance the schedule when the next occurrence would exceed repeat_stop_at", async () => {
    mockListDue.mockResolvedValue([
      mkEvent({
        scheduledAt: "2026-04-17T09:00:00.000Z",
        repeatInterval: "1day",
        repeatStopAt: "2026-04-17T23:59:59.999Z",
      }),
    ]);
    mockGetAgent.mockResolvedValue({
      id: "ag_1",
      workspaceId: "ws_1",
      runtimeId: "rt_1",
      ownerId: "u_1",
    });
    mockClaim.mockResolvedValue({ id: "ce_1" });
    mockCreateConv.mockResolvedValue({ id: "cv_1" });
    mockCreateTask.mockResolvedValue({ id: "t_1" });

    await promoteDueCalendarEventsForWorkspace(
      fakeDb,
      "ws_1",
      "2026-04-17T09:30:00.000Z"
    );

    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });
});

describe("repeatStopDateToStopAt", () => {
  it("converts YYYY-MM-DD to end-of-day ISO", () => {
    const out = repeatStopDateToStopAt("2026-05-17");
    const parsed = new Date(out);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(4); // May
    expect(parsed.getDate()).toBe(17);
    expect(parsed.getHours()).toBe(23);
    expect(parsed.getMinutes()).toBe(59);
  });

  it("throws on bad input", () => {
    expect(() => repeatStopDateToStopAt("not-a-date")).toThrow();
  });
});
