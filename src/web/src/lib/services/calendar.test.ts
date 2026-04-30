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
