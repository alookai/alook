import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockR2Get = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {}, EMAIL_BUCKET: { get: (...args: unknown[]) => mockR2Get(...args) } },
  })),
}));

const mockGetEmailById = vi.fn();
const mockGetAgent = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    email: { getEmailById: (...args: unknown[]) => mockGetEmailById(...args) },
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

function makeR2Object(text: string) {
  const buf = new TextEncoder().encode(text).buffer;
  return { arrayBuffer: () => Promise.resolve(buf) };
}

describe("GET /api/email/[id]/body", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses plain text email and returns text body", async () => {
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "emails/abc/raw" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockR2Get.mockResolvedValue(
      makeR2Object("From: a@b.com\r\nTo: c@d.com\r\nSubject: Test\r\nContent-Type: text/plain\r\n\r\nHello world")
    );

    const req = new NextRequest("http://localhost/api/email/e1/body");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("Hello world");
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(mockGetEmailById).toHaveBeenCalledWith({}, "e1", "ws1");
  });

  it("parses HTML email and returns HTML body", async () => {
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "emails/abc/raw" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockR2Get.mockResolvedValue(
      makeR2Object("From: a@b.com\r\nTo: c@d.com\r\nSubject: Test\r\nContent-Type: text/html\r\n\r\n<p>Hello</p>")
    );

    const req = new NextRequest("http://localhost/api/email/e1/body");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("<p>Hello</p>");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("extracts HTML from multipart MIME email", async () => {
    const boundary = "----=_Part_123";
    const mime = [
      "From: a@b.com",
      "To: c@d.com",
      "Subject: Test",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Plain text body",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>HTML body</p>",
      `--${boundary}--`,
    ].join("\r\n");

    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "emails/abc/raw" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockR2Get.mockResolvedValue(makeR2Object(mime));

    const req = new NextRequest("http://localhost/api/email/e1/body");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<p>HTML body</p>");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("returns 404 when R2 object not found", async () => {
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "emails/abc/raw" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockR2Get.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/e1/body");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(404);
  });

  it("returns 404 when email not found in workspace", async () => {
    mockGetEmailById.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/e1/body");
    const res = await GET(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(404);
  });
});
