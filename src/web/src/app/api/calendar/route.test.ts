import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockList = vi.fn();
const mockCreate = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    queries: {
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
      calendarEvent: {
        listCalendarEvents: (...a: unknown[]) => mockList(...a),
        createCalendarEvent: (...a: unknown[]) => mockCreate(...a),
      },
      meetingSession: {
        listMeetingsWithSchedule: vi.fn().mockResolvedValue([]),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "ws1" })),
}));

vi.mock("@/lib/api/responses", () => ({
  calendarEventToResponse: (e: any) => ({
    id: e.id,
    title: e.title,
    scheduled_at: e.scheduledAt,
    occurrence_at: e.occurrenceAt ?? e.scheduledAt,
  }),
}));

import { GET, POST } from "./route";

describe("GET /api/calendar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists events scoped to workspace, optionally filtered by agent/date range", async () => {
    mockList.mockResolvedValue([
      {
        id: "ce_1",
        title: "standup",
        scheduledAt: "2026-04-17T09:00:00.000Z",
        repeatInterval: null,
        repeatStopAt: null,
        exceptions: [],
      },
    ]);
    const req = new NextRequest(
      "http://localhost/api/calendar?agentId=ag_1&from=2026-04-01T00:00:00.000Z&to=2026-04-30T23:59:59.999Z"
    );
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    const res = await GET(req, {} as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("ce_1");
    expect(mockList).toHaveBeenCalledWith({}, "ws1", {
      agentId: "ag_1",
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-30T23:59:59.999Z",
    });
  });

  it("returns 404 when filter agent is not in the workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/calendar?agentId=ag_nope");
    const res = await GET(req, {} as any);
    expect(res.status).toBe(404);
  });

  it("expands daily recurring events into one row per occurrence", async () => {
    mockList.mockResolvedValue([
      {
        id: "ce_1",
        title: "daily",
        scheduledAt: "2026-04-17T09:00:00.000Z",
        repeatInterval: "1day",
        repeatStopAt: null,
        exceptions: [],
      },
    ]);
    const req = new NextRequest(
      "http://localhost/api/calendar?from=2026-04-17T00:00:00.000Z&to=2026-04-20T23:59:59.999Z"
    );
    const res = await GET(req, {} as any);
    const body = await res.json();
    expect(body).toHaveLength(4);
    expect(body.map((b: { occurrence_at: string }) => b.occurrence_at)).toEqual([
      "2026-04-17T09:00:00.000Z",
      "2026-04-18T09:00:00.000Z",
      "2026-04-19T09:00:00.000Z",
      "2026-04-20T09:00:00.000Z",
    ]);
  });

  it("skips occurrences in the parent's exceptions list", async () => {
    mockList.mockResolvedValue([
      {
        id: "ce_1",
        title: "daily",
        scheduledAt: "2026-04-17T09:00:00.000Z",
        repeatInterval: "1day",
        repeatStopAt: null,
        exceptions: ["2026-04-19T09:00:00.000Z"],
      },
    ]);
    const req = new NextRequest(
      "http://localhost/api/calendar?from=2026-04-17T00:00:00.000Z&to=2026-04-20T23:59:59.999Z"
    );
    const res = await GET(req, {} as any);
    const body = await res.json();
    expect(body.map((b: { occurrence_at: string }) => b.occurrence_at)).toEqual([
      "2026-04-17T09:00:00.000Z",
      "2026-04-18T09:00:00.000Z",
      "2026-04-20T09:00:00.000Z",
    ]);
  });

  it("does not expand non-recurring rows", async () => {
    mockList.mockResolvedValue([
      {
        id: "ce_1",
        title: "one-off",
        scheduledAt: "2026-04-17T09:00:00.000Z",
        repeatInterval: null,
        repeatStopAt: null,
        exceptions: [],
      },
    ]);
    const req = new NextRequest(
      "http://localhost/api/calendar?from=2026-04-01T00:00:00.000Z&to=2026-04-30T23:59:59.999Z"
    );
    const res = await GET(req, {} as any);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });
});

describe("POST /api/calendar", () => {
  beforeEach(() => vi.clearAllMocks());

  async function post(body: unknown) {
    const req = new NextRequest("http://localhost/api/calendar", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return POST(req, {} as any);
  }

  it("rejects malformed repeat_interval", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    const res = await post({
      agent_id: "ag_1",
      title: "test",
      scheduled_at: "2026-04-17T09:00:00.000Z",
      repeat_interval: "weekly",
    });
    expect(res.status).toBe(400);
  });

  it("rejects repeat_stop_date without repeat_interval", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    const res = await post({
      agent_id: "ag_1",
      title: "test",
      scheduled_at: "2026-04-17T09:00:00.000Z",
      repeat_stop_date: "2026-05-17",
    });
    expect(res.status).toBe(400);
  });

  it("rejects repeat_stop_date earlier than the first scheduled occurrence", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    const res = await post({
      agent_id: "ag_1",
      title: "test",
      scheduled_at: "2026-04-17T09:00:00.000Z",
      repeat_interval: "1day",
      repeat_stop_date: "2026-04-16",
    });
    expect(res.status).toBe(400);
  });

  it("404s when the agent does not belong to the workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await post({
      agent_id: "ag_missing",
      title: "test",
      scheduled_at: "2026-04-17T09:00:00.000Z",
    });
    expect(res.status).toBe(404);
  });

  it("creates the event with repeat_stop_at derived from repeat_stop_date", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    mockCreate.mockImplementation((_db, data) => ({
      id: "ce_1",
      ...data,
    }));
    const res = await post({
      agent_id: "ag_1",
      title: "standup",
      scheduled_at: "2026-04-17T09:00:00.000Z",
      repeat_interval: "1day",
      repeat_stop_date: "2026-05-17",
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][1];
    expect(payload.agentId).toBe("ag_1");
    expect(payload.workspaceId).toBe("ws1");
    expect(payload.repeatInterval).toBe("1day");
    expect(payload.repeatStopAt).toMatch(/2026-05-1[78]T/);
  });

  it("passes description through to create and echoes it in the response", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    mockCreate.mockImplementation((_db, data) => ({
      id: "ce_1",
      title: data.title,
      description: data.description,
    }));
    const res = await post({
      agent_id: "ag_1",
      title: "standup",
      description: "<p>hello</p>",
      scheduled_at: "2026-04-17T09:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const payload = mockCreate.mock.calls[0][1];
    expect(payload.description).toBe("<p>hello</p>");
  });

  it("sets description to null when omitted", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    mockCreate.mockImplementation((_db, data) => ({ id: "ce_1", ...data }));
    const res = await post({
      agent_id: "ag_1",
      title: "standup",
      scheduled_at: "2026-04-17T09:00:00.000Z",
    });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0][1].description).toBeNull();
  });

  it("normalizes empty-HTML description to null", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_1" });
    mockCreate.mockImplementation((_db, data) => ({ id: "ce_1", ...data }));
    const res = await post({
      agent_id: "ag_1",
      title: "standup",
      description: "<p></p>",
      scheduled_at: "2026-04-17T09:00:00.000Z",
    });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0][1].description).toBeNull();
  });
});
