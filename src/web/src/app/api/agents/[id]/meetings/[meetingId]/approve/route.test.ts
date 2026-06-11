import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { MeetingStatus } from "@alook/shared";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockGetAgent = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      meetingSession: {
        getMeetingSession: (...a: unknown[]) => mockGet(...a),
        updateMeetingSession: (...a: unknown[]) => mockUpdate(...a),
      },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
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

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: "a1", visibility: "public", ownerId: "u1" });
});

const params = { id: "a1", meetingId: "m1" };
const post = () => POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });

describe("POST .../meetings/[meetingId]/approve", () => {
  it("approves a pending meeting → scheduled", async () => {
    mockGet.mockResolvedValue({ id: "m1", status: MeetingStatus.PENDING });
    mockUpdate.mockResolvedValue({ id: "m1", status: MeetingStatus.SCHEDULED });
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({}, "m1", "w1", { status: MeetingStatus.SCHEDULED });
  });

  it("400 when meeting id missing", async () => {
    const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params: { id: "a1" } });
    expect(res.status).toBe(400);
  });

  it("404 when meeting not in workspace", async () => {
    mockGet.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
  });

  it("400 when meeting is not pending", async () => {
    mockGet.mockResolvedValue({ id: "m1", status: MeetingStatus.SCHEDULED });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("only pending meetings can be approved");
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
