import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const q = {
  getAllAgents: vi.fn(),
  getAllAccess: vi.fn(),
  emailStats: vi.fn(),
  emailAccounts: vi.fn(),
  taskStats: vi.fn(),
  recentTasks: vi.fn(),
  convCounts: vi.fn(),
  members: vi.fn(),
  invites: vi.fn(),
  calendar: vi.fn(),
};

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAllAgentsForWorkspace: (...a: unknown[]) => q.getAllAgents(...a) },
      agentAccess: { getAllAgentAccessForWorkspace: (...a: unknown[]) => q.getAllAccess(...a) },
      overview: {
        getEmailStatsByWorkspace: (...a: unknown[]) => q.emailStats(...a),
        getEmailAccountsByWorkspace: (...a: unknown[]) => q.emailAccounts(...a),
        getTaskStatsByWorkspace: (...a: unknown[]) => q.taskStats(...a),
        getRecentTerminalTasks: (...a: unknown[]) => q.recentTasks(...a),
        getConversationCountsByAgent: (...a: unknown[]) => q.convCounts(...a),
      },
      member: { listMembers: (...a: unknown[]) => q.members(...a) },
      workspaceInvite: { listActiveInvites: (...a: unknown[]) => q.invites(...a) },
      calendarEvent: { listCalendarEvents: (...a: unknown[]) => q.calendar(...a) },
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
vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_k: string, _t: number, fn: () => Promise<any>) => fn()),
  cacheKeys: {
    allAgents: (w: string) => `ag:${w}`, allAgentAccess: (w: string) => `aa:${w}`,
    overviewEmailStats: (w: string) => `es:${w}`, overviewEmailAccounts: (w: string) => `ea:${w}`,
    overviewTaskStats: (w: string, d: string) => `ts:${w}:${d}`, allMembers: (w: string) => `mem:${w}`,
  },
}));
vi.mock("@/lib/agent-visibility", () => ({ filterVisibleAgents: vi.fn((a: any[]) => a) }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  q.getAllAgents.mockResolvedValue([{ id: "a1" }]);
  q.getAllAccess.mockResolvedValue([]);
  q.emailStats.mockResolvedValue({ total: 5 });
  q.emailAccounts.mockResolvedValue([{ id: "ea1", agentId: "a1", emailAddress: "x@t.com", status: "ok", errorMessage: null, lastSyncedAt: null }]);
  q.taskStats.mockResolvedValue({ done: 2 });
  q.recentTasks.mockResolvedValue([{ id: "t1", agentId: "a1", type: "dm", status: "completed", prompt: "p", createdAt: "d", completedAt: "d", error: null }]);
  q.convCounts.mockResolvedValue([{ agentId: "a1", cnt: 3 }]);
  q.members.mockResolvedValue([{ id: "m1", userId: "u1", role: "owner", userName: "U", userEmail: "u@t.com", userImage: null, createdAt: "d" }]);
  q.invites.mockResolvedValue([{ id: "i1" }, { id: "i2" }]);
  q.calendar.mockResolvedValue([{ id: "c1", agentId: "a1", title: "T", description: "", scheduledAt: "d", repeatInterval: null, repeatStopAt: null, lastTriggeredAt: null }]);
});

describe("GET /api/workspaces/[id]/overview", () => {
  it("aggregates the workspace dashboard payload", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), { params: { id: "w1" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.email_stats).toEqual({ total: 5 });
    expect(body.conversation_counts).toEqual({ a1: 3 });
    expect(body.pending_invites).toBe(2);
    expect(body.recent_tasks[0].id).toBe("t1");
    expect(body.calendar_events[0].title).toBe("T");
    // visible-agent scoping passed to recent tasks / conv counts
    expect(q.recentTasks).toHaveBeenCalledWith({}, "w1", ["a1"], 15);
  });
});
