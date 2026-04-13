import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetEmailById = vi.fn();
const mockGetAgentInWorkspace = vi.fn();
const mockDeleteEmail = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {}, EMAIL_BUCKET: {} },
  })),
}));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    email: {
      getEmailById: (...args: unknown[]) => mockGetEmailById(...args),
      deleteEmail: (...args: unknown[]) => mockDeleteEmail(...args),
    },
    agent: {
      getAgentInWorkspace: (...args: unknown[]) => mockGetAgentInWorkspace(...args),
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

import { GET, DELETE } from "./route";

describe("DELETE /api/email/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes an email and returns 204", async () => {
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1" });
    mockGetAgentInWorkspace.mockResolvedValue({ id: "a1" });
    mockDeleteEmail.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/email/e1?workspace_id=ws1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(204);
    expect(mockDeleteEmail).toHaveBeenCalledWith({}, "e1");
  });

  it("returns 404 when email not found", async () => {
    mockGetEmailById.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/e1?workspace_id=ws1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(404);
  });

  it("returns 404 when agent not in workspace", async () => {
    mockGetEmailById.mockResolvedValue({ id: "e1", agentId: "a1" });
    mockGetAgentInWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/e1?workspace_id=ws1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "e1" }) } as any);

    expect(res.status).toBe(404);
  });
});
