import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetAgent = vi.fn();
const mockGetRuntime = vi.fn();
const mockGetSkills = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
      runtime: { getAgentRuntime: (...a: unknown[]) => mockGetRuntime(...a) },
      agentSkill: { getSkills: (...a: unknown[]) => mockGetSkills(...a) },
    },
  };
});
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

function get(url: string, params: Record<string, string>) {
  return GET(new NextRequest(url), { params });
}

describe("GET /api/agents/[id]/skills", () => {
  it("400 when agent id missing", async () => {
    const res = await get("http://localhost/x?workspace_id=w1", {});
    expect(res.status).toBe(400);
  });

  it("400 when workspace_id missing", async () => {
    const res = await get("http://localhost/x", { id: "a1" });
    expect(res.status).toBe(400);
  });

  it("404 when agent not found in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await get("http://localhost/x?workspace_id=w1", { id: "a1" });
    expect(res.status).toBe(404);
    expect(mockGetAgent).toHaveBeenCalledWith({}, "a1", "w1", "u1");
  });

  it("returns skills for the agent's runtime provider", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: "rt1" });
    mockGetRuntime.mockResolvedValue({ provider: "codex" });
    mockGetSkills.mockResolvedValue([{ name: "skill-a" }]);
    const res = await get("http://localhost/x?workspace_id=w1", { id: "a1" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skills).toEqual([{ name: "skill-a" }]);
    expect(mockGetSkills).toHaveBeenCalledWith({}, "a1", "codex", "w1");
  });

  it("defaults to claude when the runtime provider is unknown", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: "rt1" });
    mockGetRuntime.mockResolvedValue({ provider: "weird-runtime" });
    mockGetSkills.mockResolvedValue([]);
    await get("http://localhost/x?workspace_id=w1", { id: "a1" });
    expect(mockGetSkills).toHaveBeenCalledWith({}, "a1", "claude", "w1");
  });

  it("defaults to claude when agent has no runtimeId", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", runtimeId: null });
    mockGetSkills.mockResolvedValue([]);
    await get("http://localhost/x?workspace_id=w1", { id: "a1" });
    expect(mockGetSkills).toHaveBeenCalledWith({}, "a1", "claude", "w1");
    expect(mockGetRuntime).not.toHaveBeenCalled();
  });
});
