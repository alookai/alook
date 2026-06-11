import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, EMAIL_BUCKET: { put: vi.fn() }, WORKER_SELF_REFERENCE: { fetch: vi.fn() } } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "id123") }));
vi.mock("unique-names-generator", () => ({
  uniqueNamesGenerator: vi.fn(() => "Robin"),
  names: [],
}));
vi.mock("@/components/avatar", () => ({
  randomConfig: vi.fn(() => ({})),
  serializeAvatarConfig: vi.fn(() => "avatar-url"),
}));

const mockGetAgent = vi.fn();
const mockGetRuntimeForWs = vi.fn();
const mockGetAllHandles = vi.fn();
const mockCreateAgent = vi.fn();
const mockLinkCreate = vi.fn();
const mockAddWhitelist = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: {
        getAgent: (...a: unknown[]) => mockGetAgent(...a),
        getAllHandlesForWorkspace: (...a: unknown[]) => mockGetAllHandles(...a),
        createAgent: (...a: unknown[]) => mockCreateAgent(...a),
      },
      runtime: { getAgentRuntimeForWorkspace: (...a: unknown[]) => mockGetRuntimeForWs(...a) },
      agentLink: { create: (...a: unknown[]) => mockLinkCreate(...a) },
      whitelist: { addWhitelist: (...a: unknown[]) => mockAddWhitelist(...a) },
    },
  };
});

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
  agentToResponse: (a: any) => ({ id: a.id, name: a.name }),
  agentLinkToResponse: (l: any) => ({ id: l.id }),
}));
vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  cached: vi.fn((_k: string, _t: number, fn: () => Promise<any>) => fn()),
  cacheKeys: {
    allAgents: () => "a", allHandles: () => "h", allAgentAccess: () => "aa",
    allColleagues: () => "c", agentLinks: () => "al",
  },
}));
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

const VALID = { instructions: "do things", relationship: "reports to me" };

function post(body: unknown, qs = "?agentId=caller") {
  return POST(
    new NextRequest(`http://localhost/api/agents/recruit${qs}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    {},
  );
}

describe("POST /api/agents/recruit", () => {
  it("400 when agentId query param missing", async () => {
    const res = await post(VALID, "");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("agentId");
  });

  it("400 on invalid body (missing instructions/relationship)", async () => {
    const res = await post({ name: "X" });
    expect(res.status).toBe(400);
  });

  it("404 when calling agent not in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await post(VALID);
    expect(res.status).toBe(404);
    expect(mockGetAgent).toHaveBeenCalledWith({}, "caller", "w1", "u1");
  });

  it("400 when calling agent has no runtime", async () => {
    mockGetAgent.mockResolvedValue({ id: "caller", runtimeId: "rt1", emailHandle: null });
    mockGetRuntimeForWs.mockResolvedValue(null);
    const res = await post(VALID);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no runtime");
  });

  it("creates a recruited agent + link, scoped to workspace (201)", async () => {
    mockGetAgent.mockResolvedValue({ id: "caller", runtimeId: "rt1", emailHandle: null, name: "Caller" });
    mockGetRuntimeForWs.mockResolvedValue({ runtimeMode: "local", machineLastSeenAt: null });
    mockGetAllHandles.mockResolvedValue([]);
    mockCreateAgent.mockResolvedValue({ id: "new1", name: "Robin" });
    mockLinkCreate.mockResolvedValue({ id: "link1" });

    const res = await post(VALID);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.agent.id).toBe("new1");
    expect(body.agent.email).toBe("robin@alook.ai");
    expect(body.link.id).toBe("link1");
    expect(mockCreateAgent.mock.calls[0]![1]).toMatchObject({ workspaceId: "w1", ownerId: "u1" });
    expect(mockLinkCreate.mock.calls[0]![1]).toMatchObject({
      workspaceId: "w1", sourceAgentId: "caller", targetAgentId: "new1",
    });
  });
});
