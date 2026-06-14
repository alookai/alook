import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockListFlaggedMessageIds = vi.fn();
const mockListFlaggedMessages = vi.fn();
const mockGetMessageWorkspaceId = vi.fn();
const mockFlagMessage = vi.fn();

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    messageFlag: {
      listFlaggedMessageIds: (...args: unknown[]) => mockListFlaggedMessageIds(...args),
      listFlaggedMessages: (...args: unknown[]) => mockListFlaggedMessages(...args),
      getMessageWorkspaceId: (...args: unknown[]) => mockGetMessageWorkspaceId(...args),
      flagMessage: (...args: unknown[]) => mockFlagMessage(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { GET, POST } from "./route";

describe("GET /api/flags", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("ids_only=true", () => {
    it("returns 400 when conversation_id is missing", async () => {
      const req = new NextRequest("http://localhost/api/flags?ids_only=true");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("conversation_id");
    });

    it("returns message_ids when conversation_id is provided", async () => {
      mockListFlaggedMessageIds.mockResolvedValue(["m1", "m2"]);

      const req = new NextRequest("http://localhost/api/flags?ids_only=true&conversation_id=c1");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message_ids: ["m1", "m2"] });
      expect(mockListFlaggedMessageIds).toHaveBeenCalledWith({}, "u1", "w1", "c1");
    });
  });

  describe("normal list", () => {
    it("returns flagged messages with defaults (limit=30, no before)", async () => {
      mockListFlaggedMessages.mockResolvedValue({ items: [{ id: "m1" }], hasMore: false });

      const req = new NextRequest("http://localhost/api/flags");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [{ id: "m1" }], has_more: false });
      expect(mockListFlaggedMessages).toHaveBeenCalledWith({}, "u1", "w1", { limit: 30, before: undefined });
    });

    it("clamps limit to 1-100 range", async () => {
      mockListFlaggedMessages.mockResolvedValue({ items: [], hasMore: false });

      const req = new NextRequest("http://localhost/api/flags?limit=200");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(200);
      expect(mockListFlaggedMessages).toHaveBeenCalledWith({}, "u1", "w1", { limit: 100, before: undefined });
    });

    it("clamps limit minimum to 1", async () => {
      mockListFlaggedMessages.mockResolvedValue({ items: [], hasMore: false });

      const req = new NextRequest("http://localhost/api/flags?limit=-5");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(200);
      expect(mockListFlaggedMessages).toHaveBeenCalledWith({}, "u1", "w1", { limit: 1, before: undefined });
    });

    it("passes valid before timestamp", async () => {
      mockListFlaggedMessages.mockResolvedValue({ items: [], hasMore: false });

      const req = new NextRequest("http://localhost/api/flags?before=2024-01-01T00:00:00Z");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(200);
      expect(mockListFlaggedMessages).toHaveBeenCalledWith({}, "u1", "w1", { limit: 30, before: "2024-01-01T00:00:00Z" });
    });

    it("returns 400 for invalid before timestamp", async () => {
      const req = new NextRequest("http://localhost/api/flags?before=not-a-date");
      const res = await GET(req, {} as any);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("invalid before timestamp");
    });
  });
});

describe("POST /api/flags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when messageId is missing", async () => {
    const req = new NextRequest("http://localhost/api/flags", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("messageId");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest("http://localhost/api/flags", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(400);
  });

  it("returns 404 when message workspace id is null", async () => {
    mockGetMessageWorkspaceId.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/flags", {
      method: "POST",
      body: JSON.stringify({ messageId: "m1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "message not found" });
  });

  it("returns 404 when message belongs to different workspace", async () => {
    mockGetMessageWorkspaceId.mockResolvedValue("other-workspace");

    const req = new NextRequest("http://localhost/api/flags", {
      method: "POST",
      body: JSON.stringify({ messageId: "m1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "message not found" });
  });

  it("returns 201 when message is newly flagged", async () => {
    mockGetMessageWorkspaceId.mockResolvedValue("w1");
    mockFlagMessage.mockResolvedValue({ id: "flag1" });

    const req = new NextRequest("http://localhost/api/flags", {
      method: "POST",
      body: JSON.stringify({ messageId: "m1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ flagged: true });
    expect(mockFlagMessage).toHaveBeenCalledWith({}, { messageId: "m1", userId: "u1", workspaceId: "w1" });
  });

  it("returns 200 when message is already flagged", async () => {
    mockGetMessageWorkspaceId.mockResolvedValue("w1");
    mockFlagMessage.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/flags", {
      method: "POST",
      body: JSON.stringify({ messageId: "m1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flagged: true });
  });
});
