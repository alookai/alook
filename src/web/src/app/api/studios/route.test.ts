import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/components/avatar", () => ({
  randomConfig: vi.fn(() => ({ shape: "circle", color: "#ff0000" })),
  serializeAvatarConfig: vi.fn(() => "generated-avatar-config"),
}));

const mockCreateAgent = vi.fn();
const mockGetAgentByHandle = vi.fn();
const mockListAgents = vi.fn();
const mockGetAgentRuntimeForWorkspace = vi.fn();
const mockGetAgentRuntimesForWorkspace = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetWorkspaceBySlug = vi.fn();
const mockUpdateWorkspace = vi.fn();
const mockAddWhitelist = vi.fn();
const mockCreateLink = vi.fn();
const mockCreateConversation = vi.fn();
const mockEnqueueTask = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn(),
  cached: vi.fn((_key: string, _ttl: number, fn: () => Promise<any>) => fn()),
  cacheKeys: {
    allAgents: (ws: string) => `agents:${ws}`,
    allHandles: (ws: string) => `handles:${ws}`,
    allColleagues: (ws: string) => `col:${ws}`,
    allAgentAccess: (ws: string) => `aa:${ws}`,
    allMembers: (ws: string) => `members:${ws}`,
    overviewTaskStats: (ws: string, d: string) => `ov_task:${ws}:${d}`,
    agentLinks: (ws: string) => `al:${ws}`,
  },
}));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    isOnline: vi.fn((t: string | null) => !!t && Date.now() - new Date(t).getTime() < 30_000),
    queries: {
      agent: {
        createAgent: (...args: unknown[]) => mockCreateAgent(...args),
        getAgentByHandle: (...args: unknown[]) => mockGetAgentByHandle(...args),
        listAgents: (...args: unknown[]) => mockListAgents(...args),
        getAllHandlesForWorkspace: vi.fn().mockResolvedValue([]),
      },
      runtime: {
        getAgentRuntimeForWorkspace: (...args: unknown[]) => mockGetAgentRuntimeForWorkspace(...args),
        getAgentRuntimesForWorkspace: (...args: unknown[]) => mockGetAgentRuntimesForWorkspace(...args),
      },
      workspace: {
        getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
        getWorkspaceBySlug: (...args: unknown[]) => mockGetWorkspaceBySlug(...args),
        updateWorkspace: (...args: unknown[]) => mockUpdateWorkspace(...args),
      },
      whitelist: {
        addWhitelist: (...args: unknown[]) => mockAddWhitelist(...args),
      },
      agentLink: {
        create: (...args: unknown[]) => mockCreateLink(...args),
      },
      conversation: {
        createConversation: (...args: unknown[]) => mockCreateConversation(...args),
      },
      agentPin: {
        pinAgent: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@test.com", params });
  }),
}));

const mockWithWorkspaceMember = vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" }));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: (...args: unknown[]) => mockWithWorkspaceMember(...args),
}));

vi.mock("@/lib/api/responses", () => ({
  agentToResponse: vi.fn((a: any) => ({ id: a.id, name: a.name, email_handle: a.emailHandle })),
  workspaceToResponse: vi.fn((w: any) => ({ id: w.id, name: w.name, slug: w.slug })),
  agentLinkToResponse: vi.fn((l: any) => ({ id: l.id, source_agent_id: l.sourceAgentId, target_agent_id: l.targetAgentId })),
}));

vi.mock("@/lib/services/task", () => {
  const Svc = function () {
    return { enqueueTask: mockEnqueueTask };
  };
  return { TaskService: Svc };
});

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkspace.mockResolvedValue({ id: "w1", name: "My Workspace", slug: "my-workspace" });
  mockGetWorkspaceBySlug.mockResolvedValue(null);
  mockUpdateWorkspace.mockResolvedValue({ id: "w1", name: "Atlas Lab", slug: "atlas-lab" });
  mockGetAgentByHandle.mockResolvedValue(null);
  mockListAgents.mockResolvedValue([]);
  mockGetAgentRuntimeForWorkspace.mockResolvedValue({
    id: "rt1",
    runtimeMode: "local",
    machineLastSeenAt: new Date().toISOString(),
  });
  mockGetAgentRuntimesForWorkspace.mockResolvedValue([{
    id: "rt1",
    runtimeMode: "local",
    machineLastSeenAt: new Date().toISOString(),
  }]);
  let agentIdx = 0;
  mockCreateAgent.mockImplementation((_db: any, data: any) => {
    agentIdx++;
    return { id: `agent-${agentIdx}`, ...data, emailHandle: `handle-${agentIdx}` };
  });
  mockCreateLink.mockImplementation((_db: any, data: any) => ({
    id: `link-${data.sourceAgentId}-${data.targetAgentId}`,
    ...data,
  }));
  mockCreateConversation.mockResolvedValue({ id: "conv1" });
  mockEnqueueTask.mockResolvedValue({});
});

describe("POST /api/studios", () => {
  it("creates agents and links for a 3-member studio", async () => {
    // First call (checking existing agents for slug safety) returns empty,
    // second call (fetching created agents for response) returns the new agents
    mockListAgents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "agent-1", name: "Jarvis", emailHandle: "atlas-lab-jarvis" },
        { id: "agent-2", name: "Mira", emailHandle: "atlas-lab-mira" },
        { id: "agent-3", name: "Linus", emailHandle: "atlas-lab-linus" },
      ]);

    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        name: "Atlas Lab",
        scenario: "software-dev",
        members: [
          { name: "Jarvis", role: "leader", runtime_id: "rt1" },
          { name: "Mira", role: "researcher", runtime_id: "rt1", relationship: "Delegate research tasks\n\nReport findings" },
          { name: "Linus", role: "engineer", runtime_id: "rt1", relationship: "Delegate coding tasks\n\nReport implementation" },
        ],
      }),
    });

    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockCreateAgent).toHaveBeenCalledTimes(3);
    expect(mockCreateLink).toHaveBeenCalledTimes(2);
    expect(body.leader_agent_id).toBe("agent-1");
    expect(body.agents).toHaveLength(3);
    expect(body.links).toHaveLength(2);
  });

  it("creates a single agent studio (no links)", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [{ name: "Solo", role: "leader", runtime_id: "rt1" }],
      }),
    });

    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(body.leader_agent_id).toBe("agent-1");
  });

  it("returns 400 if members array is empty", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({ members: [] }),
    });

    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 if no leader role", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [
          { name: "Mira", role: "researcher", runtime_id: "rt1" },
          { name: "Linus", role: "engineer", runtime_id: "rt1" },
        ],
      }),
    });

    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 404 if runtime not in workspace", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);
    mockGetAgentRuntimesForWorkspace.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [{ name: "Jarvis", role: "leader", runtime_id: "bad-rt" }],
      }),
    });

    const res = await POST(req, {});
    expect(res.status).toBe(404);
  });

  it("updates workspace name and slug when no existing agents", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Studio",
        members: [{ name: "Jarvis", role: "leader", runtime_id: "rt1" }],
      }),
    });

    await POST(req, {});

    expect(mockUpdateWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "w1",
      expect.objectContaining({ name: "Dev Studio", slug: "dev-studio" }),
    );
  });

  it("only updates display name when workspace has existing agents", async () => {
    mockListAgents.mockResolvedValue([{ id: "existing-agent" }]);

    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        name: "New Name",
        members: [{ name: "Jarvis", role: "leader", runtime_id: "rt1" }],
      }),
    });

    await POST(req, {});

    expect(mockUpdateWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "w1",
      { name: "New Name" },
    );
  });

  it("enqueues welcome email and welcome chat for leader", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [
          { name: "Jarvis", role: "leader", runtime_id: "rt1" },
          { name: "Linus", role: "engineer", runtime_id: "rt1" },
        ],
      }),
    });

    await POST(req, {});

    expect(mockCreateConversation).toHaveBeenCalledTimes(2); // welcome email + welcome chat
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "agent-1",
      expect.any(String),
      "w1",
      expect.stringContaining("lead of a new AI studio"),
      expect.any(String),
    );
  });

  it("adds owner email to whitelist for each agent", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [
          { name: "Jarvis", role: "leader", runtime_id: "rt1" },
          { name: "Mira", role: "researcher", runtime_id: "rt1" },
        ],
      }),
    });

    await POST(req, {});

    expect(mockAddWhitelist).toHaveBeenCalledTimes(2);
  });

  it("auto-generates avatar when avatar_url is not provided", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [{ name: "Solo", role: "leader", runtime_id: "rt1" }],
      }),
    });

    await POST(req, {});

    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const agentData = mockCreateAgent.mock.calls[0][1];
    expect(agentData.avatarUrl).toBe("generated-avatar-config");
  });

  it("uses provided avatar_url when explicitly set", async () => {
    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [{ name: "Solo", role: "leader", runtime_id: "rt1", avatar_url: "custom-avatar" }],
      }),
    });

    await POST(req, {});

    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const agentData = mockCreateAgent.mock.calls[0][1];
    expect(agentData.avatarUrl).toBe("custom-avatar");
  });

  it("non-owner member cannot update workspace slug", async () => {
    mockWithWorkspaceMember.mockResolvedValueOnce({ workspaceId: "w1", memberRole: "member" });
    mockListAgents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "agent-1", name: "Solo", emailHandle: "solo" },
      ]);

    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        name: "Hijacked Name",
        members: [{ name: "Solo", role: "leader", runtime_id: "rt1" }],
      }),
    });

    const res = await POST(req, {});
    expect(res.status).toBe(201);
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  it("creates agents with auto-generated names when name is omitted", async () => {
    mockListAgents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "agent-1", name: "AutoName1", emailHandle: "auto1" },
        { id: "agent-2", name: "AutoName2", emailHandle: "auto2" },
      ]);

    const req = new NextRequest("http://localhost/api/studios", {
      method: "POST",
      body: JSON.stringify({
        members: [
          { role: "leader", runtime_id: "rt1", instructions: "You lead" },
          { role: "engineer", runtime_id: "rt1", instructions: "You code", relationship: "delegate tasks\n\nreport results" },
        ],
      }),
    });

    const res = await POST(req, {});
    expect(res.status).toBe(201);

    // Agents should be created with non-empty names
    expect(mockCreateAgent).toHaveBeenCalledTimes(2);
    const firstCall = mockCreateAgent.mock.calls[0][1];
    const secondCall = mockCreateAgent.mock.calls[1][1];
    expect(firstCall.name).toBeTruthy();
    expect(secondCall.name).toBeTruthy();

    // Links should still be created (index-based matching)
    expect(mockCreateLink).toHaveBeenCalledTimes(1);
    const linkCall = mockCreateLink.mock.calls[0][1];
    expect(linkCall.instruction).toContain("delegate tasks");
    expect(linkCall.instruction).toContain("report results");
  });
});
