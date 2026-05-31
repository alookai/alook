import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
  withD1Retry: vi.fn((fn: () => Promise<any>) => fn()),
}));

const mockSyncGlobal = vi.fn();
const mockSyncAgent = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agentSkill: {
        syncGlobalSkills: (...a: unknown[]) => mockSyncGlobal(...a),
        syncAgentSkills: (...a: unknown[]) => mockSyncAgent(...a),
      },
    },
  };
});

// withAuth here injects a machine-token context that includes workspaceId.
let injectWorkspaceId: string | undefined = "w1";
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: injectWorkspaceId, params });
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  injectWorkspaceId = "w1";
});

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
  );
}

describe("POST /api/daemon/skills/sync", () => {
  it("403 when no workspace (session token, not a machine token)", async () => {
    injectWorkspaceId = undefined;
    const res = await post({ scope: "global", runtime: "claude", skills: [], daemon_id: "d1" });
    expect(res.status).toBe(403);
  });

  it("syncs global skills", async () => {
    const skills = [{ name: "s", description: "d" }];
    const res = await post({ scope: "global", runtime: "claude", skills, daemon_id: "d1" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(mockSyncGlobal).toHaveBeenCalledWith({}, "w1", "claude", skills, "d1");
  });

  it("syncs agent skills when scope=agent", async () => {
    const res = await post({ scope: "agent", agent_id: "a1", runtime: "claude", skills: [], daemon_id: "d1" });
    expect(res.status).toBe(200);
    expect(mockSyncAgent).toHaveBeenCalledWith({}, "a1", "claude", "w1", []);
  });

  it("400 when scope=agent without agent_id", async () => {
    const res = await post({ scope: "agent", runtime: "claude", skills: [], daemon_id: "d1" });
    expect(res.status).toBe(400);
  });
});
