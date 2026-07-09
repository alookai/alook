import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetAllAgentsForWorkspace = vi.fn();
const mockGetAllEmailAccountsForWorkspace = vi.fn();
const mockGetAllColleaguesForWorkspace = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();
const mockGetUser = vi.fn();
const mockGetConversation = vi.fn();
const mockGetConversationsByIds = vi.fn();

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      agent: {
        getAllAgentsForWorkspace: (...args: unknown[]) => mockGetAllAgentsForWorkspace(...args),
      },
      emailAccount: {
        getAllEmailAccountsForWorkspace: (...args: unknown[]) => mockGetAllEmailAccountsForWorkspace(...args),
      },
      agentLink: {
        getAllColleaguesForWorkspace: (...args: unknown[]) => mockGetAllColleaguesForWorkspace(...args),
      },
      member: {
        getMemberByUserAndWorkspace: (...args: unknown[]) => mockGetMemberByUserAndWorkspace(...args),
      },
      user: {
        getUserSelf: (...args: unknown[]) => mockGetUser(...args),
      },
      conversation: {
        getConversation: (...args: unknown[]) => mockGetConversation(...args),
        getConversationsByIds: (...args: unknown[]) => mockGetConversationsByIds(...args),
      },
    },
  };
});

vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, fn: () => Promise<any>) => fn()),
  cacheKeys: {
    allAgents: (wsId: string) => `agents:${wsId}`,
    allEmailAccounts: (wsId: string) => `ea:${wsId}`,
    allColleagues: (wsId: string) => `col:${wsId}`,
    member: (wsId: string, userId: string) => `mem:${wsId}:${userId}`,
    user: (userId: string) => `usr:${userId}`,
  },
}));

vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (t: any) => ({
    id: t.id,
    agent_id: t.agentId,
    runtime_id: t.runtimeId,
    workspace_id: t.workspaceId,
    prompt: t.prompt,
    status: t.status,
    type: t.type,
  }),
}));

import { TaskPayloadBuilder } from "./task-payload-builder";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    agentId: "a1",
    runtimeId: "r1",
    workspaceId: "w1",
    conversationId: "c1",
    prompt: "do something",
    status: "dispatched",
    priority: 1,
    result: null,
    context: null,
    type: "user_dm_message",
    contextKey: null,
    sessionId: null,
    createdAt: new Date("2026-01-01"),
    dispatchedAt: new Date("2026-01-01"),
    startedAt: null,
    completedAt: null,
    error: null,
    traceId: null,
    parentTaskId: null,
    ...overrides,
  };
}

describe("TaskPayloadBuilder", () => {
  const db = {} as any;
  let builder: TaskPayloadBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new TaskPayloadBuilder(db);
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllEmailAccountsForWorkspace.mockResolvedValue([]);
    mockGetAllColleaguesForWorkspace.mockResolvedValue([]);
    mockGetConversationsByIds.mockResolvedValue([]);
  });

  it("returns empty array for empty input", async () => {
    const result = await builder.buildFullPayloads([], "w1");
    expect(result).toEqual([]);
    expect(mockGetAllAgentsForWorkspace).not.toHaveBeenCalled();
  });

  it("handles kill_task type (returns taskToResponse with agent: null, sender: null)", async () => {
    const task = makeTask({ type: "kill_task" });
    const result = await builder.buildFullPayloads([task], "w1");

    expect(result).toHaveLength(1);
    expect(result[0].agent).toBeNull();
    expect(result[0].sender).toBeNull();
    expect(result[0].id).toBe("t1");
    expect(mockGetAllAgentsForWorkspace).not.toHaveBeenCalled();
  });

  it("builds full payload for a normal task", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([
      { id: "a1", ownerId: "owner1", instructions: "be helpful", name: "Bot", runtimeConfig: { model: "gpt-4" }, emailHandle: "bot" },
    ]);
    mockGetAllEmailAccountsForWorkspace.mockResolvedValue([
      { agentId: "a1", emailAddress: "custom@company.com" },
    ]);
    mockGetAllColleaguesForWorkspace.mockResolvedValue([
      { agentId: "a1", name: "Helper", emailHandle: "helper", description: "helps", instruction: "be nice" },
    ]);
    mockGetUser.mockResolvedValue({ name: "Owner", email: "owner@ex.com" });
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ globalInstruction: "" });
    mockGetConversationsByIds.mockResolvedValue([{ id: "c1", userId: "sender1", channel: "slack" }]);
    mockGetUser
      .mockResolvedValueOnce({ name: "Owner", email: "owner@ex.com" })
      .mockResolvedValueOnce({ name: "Sender", email: "sender@ex.com" });

    const task = makeTask({ type: "user_dm_message" });
    const result = await builder.buildFullPayloads([task], "w1");

    expect(result).toHaveLength(1);
    expect(result[0].agent).toMatchObject({
      instructions: "be helpful",
      name: "Bot",
      runtime_config: { model: "gpt-4" },
      email_handle: "bot",
      email_addresses: ["bot@alook.ai", "custom@company.com"],
      colleagues: [{ name: "Helper", email: "helper@alook.ai", description: "helps", instruction: "be nice" }],
    });
    expect(result[0].channel).toBe("slack");
    expect(result[0].sender).toMatchObject({ name: "Sender", email: "sender@ex.com" });
  });

  it("merges globalInstruction from member into agent instructions", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([
      { id: "a1", ownerId: "owner1", instructions: "agent rules", name: "Bot", runtimeConfig: {} },
    ]);
    mockGetAllEmailAccountsForWorkspace.mockResolvedValue([]);
    mockGetAllColleaguesForWorkspace.mockResolvedValue([]);
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ globalInstruction: "speak english" });
    mockGetUser.mockResolvedValue({ name: "Owner", email: "owner@ex.com" });
    mockGetConversationsByIds.mockResolvedValue([]);

    const task = makeTask();
    const result = await builder.buildFullPayloads([task], "w1");

    expect(result[0].agent!.instructions).toBe("speak english\n\nagent rules");
  });

  it("handles task where agent is not found (agent: null)", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([]);
    mockGetAllEmailAccountsForWorkspace.mockResolvedValue([]);
    mockGetAllColleaguesForWorkspace.mockResolvedValue([]);
    mockGetConversationsByIds.mockResolvedValue([]);

    const task = makeTask({ agentId: "nonexistent" });
    const result = await builder.buildFullPayloads([task], "w1");

    expect(result).toHaveLength(1);
    expect(result[0].agent).toBeNull();
  });

  it("dedupes DB queries when multiple tasks share the same agent", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([
      { id: "a1", ownerId: "owner1", instructions: "shared", name: "Bot", runtimeConfig: {} },
    ]);
    mockGetAllEmailAccountsForWorkspace.mockResolvedValue([]);
    mockGetAllColleaguesForWorkspace.mockResolvedValue([]);
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ globalInstruction: "" });
    mockGetUser.mockResolvedValue({ name: "Owner", email: "owner@ex.com" });
    mockGetConversationsByIds.mockResolvedValue([]);

    const task1 = makeTask({ id: "t1", agentId: "a1" });
    const task2 = makeTask({ id: "t2", agentId: "a1" });
    const result = await builder.buildFullPayloads([task1, task2], "w1");

    expect(result).toHaveLength(2);
    expect(result[0].agent!.name).toBe("Bot");
    expect(result[1].agent!.name).toBe("Bot");
    expect(mockGetAllAgentsForWorkspace).toHaveBeenCalledTimes(1);
    expect(mockGetAllEmailAccountsForWorkspace).toHaveBeenCalledTimes(1);
    expect(mockGetAllColleaguesForWorkspace).toHaveBeenCalledTimes(1);
    expect(mockGetMemberByUserAndWorkspace).toHaveBeenCalledTimes(1);
  });
});
