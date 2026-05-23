import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockDeleteMachineToken = vi.fn();
const mockListMachineTokens = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    machineToken: {
      deleteMachineToken: (...args: unknown[]) => mockDeleteMachineToken(...args),
      listMachineTokens: (...args: unknown[]) => mockListMachineTokens(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn(),
  cacheKeys: { machineToken: (t: string) => `mt:${t.slice(0, 20)}` },
}));

import { DELETE } from "./route";

describe("DELETE /api/machine-tokens/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes token and returns 204", async () => {
    mockListMachineTokens.mockResolvedValue([{ id: "tok1", token: "al_testtoken123" }]);
    mockDeleteMachineToken.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/machine-tokens/tok1", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "tok1" }) } as any);

    expect(res.status).toBe(204);
    expect(mockDeleteMachineToken).toHaveBeenCalledWith({}, "tok1", "u1");
  });
});
