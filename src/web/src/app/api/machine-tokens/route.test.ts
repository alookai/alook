import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListMachineTokens = vi.fn();
const mockCreateMachineToken = vi.fn();
const mockGetPendingMachineToken = vi.fn();
const mockMachineTokenToResponse = vi.fn((mt: any) => ({
  id: mt.id,
  name: mt.name,
  last_used_at: null,
  created_at: "2025-01-01T00:00:00Z",
}));
const mockGenerateMachineToken = vi.fn(() => "al_abc123");

vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  writeError: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    machineToken: {
      listMachineTokens: (...args: any[]) => mockListMachineTokens(...args),
      createMachineToken: (...args: any[]) => mockCreateMachineToken(...args),
      getPendingMachineToken: (...args: any[]) => mockGetPendingMachineToken(...args),
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
vi.mock("@/lib/api/responses", () => ({
  machineTokenToResponse: (...args: any[]) => mockMachineTokenToResponse(...args),
}));
vi.mock("@/lib/token", () => ({
  generateMachineToken: (...args: any[]) => mockGenerateMachineToken(...args),
}));

import { GET, POST } from "./route";

describe("GET /api/machine-tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists tokens", async () => {
    const tokens = [
      { id: "mt1", name: "default", lastUsedAt: null, createdAt: "2025-01-01T00:00:00Z" },
      { id: "mt2", name: "ci", lastUsedAt: null, createdAt: "2025-01-01T00:00:00Z" },
    ];
    mockListMachineTokens.mockResolvedValue(tokens);

    const res = await GET(new NextRequest("http://localhost/api/machine-tokens"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "mt1", name: "default", last_used_at: null, created_at: "2025-01-01T00:00:00Z" },
      { id: "mt2", name: "ci", last_used_at: null, created_at: "2025-01-01T00:00:00Z" },
    ]);
    expect(mockListMachineTokens).toHaveBeenCalledWith({}, "u1", "w1");
  });
});

describe("POST /api/machine-tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns existing pending token if one exists", async () => {
    const pending = { id: "mt0", token: "al_existing", name: "default", lastUsedAt: null, createdAt: "2025-01-01T00:00:00Z" };
    mockGetPendingMachineToken.mockResolvedValue(pending);

    const res = await POST(
      new NextRequest("http://localhost/api/machine-tokens", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token).toBe("al_existing");
    expect(mockCreateMachineToken).not.toHaveBeenCalled();
    expect(mockGenerateMachineToken).not.toHaveBeenCalled();
  });

  it("creates pending token when none exists and returns 201", async () => {
    mockGetPendingMachineToken.mockResolvedValue(null);
    const mt = { id: "mt1", name: "my-token", lastUsedAt: null, createdAt: "2025-01-01T00:00:00Z" };
    mockCreateMachineToken.mockResolvedValue(mt);

    const res = await POST(
      new NextRequest("http://localhost/api/machine-tokens?workspace_id=w1", {
        method: "POST",
        body: JSON.stringify({ name: "my-token" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({
      token: "al_abc123",
      id: "mt1",
      name: "my-token",
      last_used_at: null,
      created_at: "2025-01-01T00:00:00Z",
    });
    expect(mockCreateMachineToken).toHaveBeenCalledWith({}, {
      userId: "u1",
      workspaceId: "w1",
      token: "al_abc123",
      name: "my-token",
      status: "pending",
    });
  });

  it("returns the raw token in the response", async () => {
    mockGetPendingMachineToken.mockResolvedValue(null);
    const mt = { id: "mt2", name: "default", lastUsedAt: null, createdAt: "2025-01-01T00:00:00Z" };
    mockCreateMachineToken.mockResolvedValue(mt);

    const res = await POST(
      new NextRequest("http://localhost/api/machine-tokens", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(body.token).toBe("al_abc123");
  });
});
