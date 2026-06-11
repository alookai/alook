import { describe, it, expect, vi } from "vitest";
import * as taskQueries from "../../src/db/queries/task";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  return chain;
}

describe("task query module exports", () => {
  it("exports listActiveTaskCountsByWorkspace", () => {
    expect(typeof taskQueries.listActiveTaskCountsByWorkspace).toBe("function");
  });

  it("exports listActiveTasksByAgent", () => {
    expect(typeof taskQueries.listActiveTasksByAgent).toBe("function");
  });

  it("exports countRunningTasks", () => {
    expect(typeof taskQueries.countRunningTasks).toBe("function");
  });

  it("exports getActiveTaskByConversation", () => {
    expect(typeof taskQueries.getActiveTaskByConversation).toBe("function");
  });

  it("exports failStaleRunningTasks", () => {
    expect(typeof taskQueries.failStaleRunningTasks).toBe("function");
  });
});

describe("task query function signatures", () => {
  it("listActiveTaskCountsByWorkspace accepts (db, workspaceId, agentIds?)", () => {
    expect(taskQueries.listActiveTaskCountsByWorkspace.length).toBe(3);
  });

  it("listActiveTasksByAgent accepts (db, agentId, workspaceId)", () => {
    expect(taskQueries.listActiveTasksByAgent.length).toBe(3);
  });
});

describe("listPendingTasksByRuntimes", () => {
  it("returns empty array for empty runtimeIds without querying DB", async () => {
    const result = await taskQueries.listPendingTasksByRuntimes(null as any, [], "ws_1");
    expect(result).toEqual([]);
  });
});

describe("claimKillTasks", () => {
  it("returns empty array for empty runtimeIds without querying DB", async () => {
    const result = await taskQueries.claimKillTasks(null as any, [], "ws_1", 10);
    expect(result).toEqual([]);
  });

  it("returns empty array for zero limit without querying DB", async () => {
    const result = await taskQueries.claimKillTasks(null as any, ["rt_1"], "ws_1", 0);
    expect(result).toEqual([]);
  });
});

describe("countTasksByTrace", () => {
  it("returns count from query", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ value: 7 }]));
    const result = await taskQueries.countTasksByTrace(chain, "trace_1");
    expect(result).toBe(7);
  });

  it("returns 0 when no results", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    const result = await taskQueries.countTasksByTrace(chain, "trace_empty");
    expect(result).toBe(0);
  });
});

describe("getLatestTaskForConversation", () => {
  it("returns null when no tasks exist", async () => {
    const mockDb = createMockDb([]);
    const result = await taskQueries.getLatestTaskForConversation(mockDb, "conv_empty");
    expect(result).toBeNull();
  });

  it("returns latest task when found", async () => {
    const task = { id: "task_1", traceId: "trace_1" };
    const mockDb = createMockDb([task]);
    const result = await taskQueries.getLatestTaskForConversation(mockDb, "conv_1");
    expect(result).toEqual(task);
  });
});

describe("getTask", () => {
  it("returns null when task not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    const result = await taskQueries.getTask(chain, "task_missing");
    expect(result).toBeNull();
  });

  it("returns task when found", async () => {
    const task = { id: "task_1", status: "running" };
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([task]));
    const result = await taskQueries.getTask(chain, "task_1");
    expect(result).toEqual(task);
  });
});

describe("getTaskStatus", () => {
  it("returns null when task not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    const result = await taskQueries.getTaskStatus(chain, "task_missing");
    expect(result).toBeNull();
  });

  it("returns status when found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ status: "completed" }]));
    const result = await taskQueries.getTaskStatus(chain, "task_1");
    expect(result).toBe("completed");
  });
});

describe("hasPendingTaskForConversation", () => {
  it("returns true when pending tasks exist", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([{ id: "task_1" }]));
    const result = await taskQueries.hasPendingTaskForConversation(chain, "conv_1");
    expect(result).toBe(true);
  });

  it("returns false when no pending tasks", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    const result = await taskQueries.hasPendingTaskForConversation(chain, "conv_empty");
    expect(result).toBe(false);
  });
});

describe("getTraceAgentsByTaskIds", () => {
  it("returns empty map for empty taskIds", async () => {
    const result = await taskQueries.getTraceAgentsByTaskIds(null as any, [], "ws_1");
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
