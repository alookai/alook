import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetEmailById = vi.fn();
const mockGetAgent = vi.fn();
const mockR2Get = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: {
        get: (...args: unknown[]) => mockR2Get(...args),
      },
    },
  })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    email: {
      getEmailById: (...args: unknown[]) => mockGetEmailById(...args),
    },
    agent: { getAgent: (...args: unknown[]) => mockGetAgent(...args) },
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

import { GET } from "./route";

describe("GET /api/email/[id]/raw", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns full raw MIME with content-type message/rfc822", async () => {
    const rawMime = "From: test@example.com\r\nSubject: Hello\r\n\r\nBody content";
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "emails/e1/raw" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockR2Get.mockResolvedValue({
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(rawMime)); c.close(); },
      }),
    });

    const req = new NextRequest("http://localhost/api/email/e1/raw");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("message/rfc822");
    const body = await res.text();
    expect(body).toBe(rawMime);
  });

  it("returns 404 when R2 object missing", async () => {
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "emails/e1/raw" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockR2Get.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/e1/raw");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(404);
  });

  it("returns 404 when email not in workspace", async () => {
    mockGetEmailById.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/e1/raw");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(404);
  });
});
