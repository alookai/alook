import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockGetEmailsByAgent = vi.fn();
const mockGetInboxEmails = vi.fn();
const mockGetSentEmails = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    agent: { getAgent: (...args: unknown[]) => mockGetAgent(...args) },
    email: {
      getEmailsByAgent: (...args: unknown[]) => mockGetEmailsByAgent(...args),
      getInboxEmails: (...args: unknown[]) => mockGetInboxEmails(...args),
      getSentEmails: (...args: unknown[]) => mockGetSentEmails(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "ws1" })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/api/responses", () => ({
  emailToResponse: (e: any) => e,
}));

import { GET } from "./route";

describe("GET /api/email", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all emails for agent (no status filter)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test" });
    mockGetEmailsByAgent.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);

    const req = new NextRequest("http://localhost/api/email?agentId=a1");
    const res = await GET(req, {} as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(mockGetEmailsByAgent).toHaveBeenCalledWith({}, "a1", "ws1", undefined);
  });

  it("filters by status=unread", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test" });
    mockGetEmailsByAgent.mockResolvedValue([{ id: "e1", status: "unread" }]);

    const req = new NextRequest("http://localhost/api/email?agentId=a1&status=unread");
    const res = await GET(req, {} as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(mockGetEmailsByAgent).toHaveBeenCalledWith({}, "a1", "ws1", "unread");
  });

  it("filters by status and folder=inbox", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test" });
    mockGetInboxEmails.mockResolvedValue([{ id: "e1" }]);

    const req = new NextRequest("http://localhost/api/email?agentId=a1&folder=inbox&status=unread");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(mockGetInboxEmails).toHaveBeenCalledWith({}, "a1", "test@alook.ai", "ws1", "unread");
  });

  it("filters by status and folder=sent", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test" });
    mockGetSentEmails.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/email?agentId=a1&folder=sent&status=read");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(mockGetSentEmails).toHaveBeenCalledWith({}, "a1", "test@alook.ai", "ws1", "read");
  });

  it("returns 400 for invalid status value", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test" });

    const req = new NextRequest("http://localhost/api/email?agentId=a1&status=invalid");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid status");
  });
});
