import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetAgent = vi.fn();
const mockPinAgent = vi.fn();
const mockUnpinAgent = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
      agentPin: {
        pinAgent: (...args: unknown[]) => mockPinAgent(...args),
        unpinAgent: (...args: unknown[]) => mockUnpinAgent(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers"),
);

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "member" })),
}));

import { POST, DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/agents/[id]/pin", () => {
  it("pins agent and returns 201 for new pin", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockPinAgent.mockResolvedValue({ id: "pin1", agentId: "a1" });

    const req = new NextRequest("http://localhost/api/agents/a1/pin", { method: "POST" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ pinned: true });
    expect(mockPinAgent).toHaveBeenCalledWith({}, { agentId: "a1", workspaceId: "w1", userId: "u1" });
  });

  it("returns 200 when already pinned", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockPinAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/pin", { method: "POST" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ pinned: true });
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/pin", { method: "POST" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
    expect(mockPinAgent).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/agents/[id]/pin", () => {
  it("unpins agent and returns 204", async () => {
    mockUnpinAgent.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/agents/a1/pin", { method: "DELETE" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(204);
    expect(mockUnpinAgent).toHaveBeenCalledWith({}, "a1", "w1", "u1");
  });

  it("returns 204 even when no pin exists (idempotent)", async () => {
    mockUnpinAgent.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/agents/no-pin/pin", { method: "DELETE" });
    const ctx = { params: Promise.resolve({ id: "no-pin" }) };
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(204);
    expect(mockUnpinAgent).toHaveBeenCalledWith({}, "no-pin", "w1", "u1");
  });
});
