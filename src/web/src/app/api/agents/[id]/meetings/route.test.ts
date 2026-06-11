import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockList = vi.fn();
const mockGetAgent = vi.fn();
const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockGetRuntime = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      meetingSession: {
        listMeetingSessions: (...a: unknown[]) => mockList(...a),
        createMeetingSession: (...a: unknown[]) => mockCreate(...a),
        getMeetingSession: (...a: unknown[]) => mockGet(...a),
      },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
      runtime: { getAgentRuntime: (...a: unknown[]) => mockGetRuntime(...a) },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/api/responses", () => ({ meetingToResponse: (m: any) => ({ id: m.id, status: m.status }) }));
vi.mock("@/lib/broadcast", () => ({ broadcastToDaemon: vi.fn().mockResolvedValue(undefined) }));

import { GET, POST } from "./route";

beforeEach(() => vi.clearAllMocks());

const VALID_URL = "https://meet.google.com/abc-defg-hij";

describe("GET /api/agents/[id]/meetings", () => {
  it("lists meetings scoped to agent + workspace", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", visibility: "public", ownerId: "u1" });
    mockList.mockResolvedValue([{ id: "m1", status: "completed" }]);
    const req = new NextRequest("http://localhost/api/agents/a1/meetings");
    const res = await GET(req, { params: { id: "a1" } });
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({}, "a1", "w1");
  });

  it("400 when agent id missing", async () => {
    const req = new NextRequest("http://localhost/api/agents/x/meetings");
    const res = await GET(req, { params: {} });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/agents/[id]/meetings", () => {
  function post(body: unknown, id = "a1") {
    return POST(
      new NextRequest("http://localhost/api/agents/a1/meetings", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: { id } },
    );
  }

  it("creates a scheduled meeting with a valid Meet URL (201)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: null, name: "A" });
    mockCreate.mockResolvedValue({ id: "m1" });
    mockGet.mockResolvedValue({ id: "m1", status: "scheduled", meetingUrl: VALID_URL, participants: [] });

    const res = await post({ meetingUrl: VALID_URL });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0]![1]).toMatchObject({ workspaceId: "w1", agentId: "a1" });
  });

  it("404 when agent not in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await post({ meetingUrl: VALID_URL });
    expect(res.status).toBe(404);
  });

  it("400 when meetingUrl missing", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("meetingUrl is required");
  });

  it("400 for a malformed Meet URL", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    const res = await post({ meetingUrl: "https://zoom.us/j/123" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid Google Meet URL format");
  });

  it("400 on invalid JSON body", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    const req = new NextRequest("http://localhost/api/agents/a1/meetings", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req, { params: { id: "a1" } });
    expect(res.status).toBe(400);
  });
});
