import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockListPins = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agentPin: {
        listPins: (...args: unknown[]) => mockListPins(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers"),
);

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "member" })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/pins", () => {
  it("returns list of pins with mapped fields", async () => {
    mockListPins.mockResolvedValue([
      { id: "pin1", agentId: "a1", createdAt: "2025-01-01T00:00:00Z" },
      { id: "pin2", agentId: "a2", createdAt: "2025-01-02T00:00:00Z" },
    ]);

    const req = new NextRequest("http://localhost/api/agents/pins");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "pin1", agent_id: "a1", created_at: "2025-01-01T00:00:00Z" },
      { id: "pin2", agent_id: "a2", created_at: "2025-01-02T00:00:00Z" },
    ]);
    expect(mockListPins).toHaveBeenCalledWith({}, "w1", "u1");
  });

  it("returns empty array when no pins", async () => {
    mockListPins.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/agents/pins");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});
