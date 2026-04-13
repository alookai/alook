import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockR2Put = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: { put: (...args: unknown[]) => mockR2Put(...args) },
    },
  })),
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

import { POST } from "./route";

describe("POST /api/email/upload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads a file and returns metadata", async () => {
    mockR2Put.mockResolvedValue(undefined);

    const formData = new FormData();
    formData.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

    const req = new NextRequest("http://localhost/api/email/upload?workspace_id=ws1", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.filename).toBe("test.txt");
    expect(body.size).toBe(11);
    expect(body.contentType).toBe("text/plain");
    expect(body.key).toContain("emails/drafts/");
    expect(body.key).toContain("/test.txt");

    expect(mockR2Put).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when no file is provided", async () => {
    const formData = new FormData();

    const req = new NextRequest("http://localhost/api/email/upload?workspace_id=ws1", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(400);
  });

  it("returns 413 when file exceeds 10 MB", async () => {
    // Create a file over 10MB
    const bigContent = new Uint8Array(10 * 1024 * 1024 + 1);
    const formData = new FormData();
    formData.append("file", new File([bigContent], "huge.bin", { type: "application/octet-stream" }));

    const req = new NextRequest("http://localhost/api/email/upload?workspace_id=ws1", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(413);
    expect(mockR2Put).not.toHaveBeenCalled();
  });
});
