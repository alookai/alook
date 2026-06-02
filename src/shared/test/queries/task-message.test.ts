import { describe, it, expect, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, asc } from "drizzle-orm";
import { taskMessage, agentTaskQueue } from "../../src/db/schema";
import * as taskMessageQueries from "../../src/db/queries/task-message";

const fakeDb = drizzle({} as never);

// Chainable mock that captures the .where() argument so we can exercise the REAL
// query fn (it's async + awaits its builder internally, so we can't .toSQL() the
// fn's return value directly — the runtime would auto-await a dead connection).
function createCapturingDb(rows: unknown[]) {
  const calls: { where?: unknown } = {};
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn((cond: unknown) => {
    calls.where = cond;
    return chain;
  });
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  return { chain, calls };
}

describe("task-message query module exports", () => {
  it("exports createTaskMessage", () => {
    expect(typeof taskMessageQueries.createTaskMessage).toBe("function");
  });

  it("exports listTaskMessages", () => {
    expect(typeof taskMessageQueries.listTaskMessages).toBe("function");
  });

  it("exports listTaskErrorMessages", () => {
    expect(typeof taskMessageQueries.listTaskErrorMessages).toBe("function");
  });

  it("exports listTaskMessagesSince", () => {
    expect(typeof taskMessageQueries.listTaskMessagesSince).toBe("function");
  });

  it("exports deleteTaskMessages", () => {
    expect(typeof taskMessageQueries.deleteTaskMessages).toBe("function");
  });
});

describe("listTaskMessages", () => {
  it("accepts (db, taskId, workspaceId?)", () => {
    expect(taskMessageQueries.listTaskMessages.length).toBe(3);
  });
});

describe("listTaskErrorMessages", () => {
  it("accepts (db, taskId, workspaceId)", () => {
    expect(taskMessageQueries.listTaskErrorMessages.length).toBe(3);
  });

  it("runs the real query: joins, builds a WHERE, and returns the rows", async () => {
    const rows = [{ id: "tm1", type: "error" }];
    const { chain, calls } = createCapturingDb(rows);
    const result = await taskMessageQueries.listTaskErrorMessages(
      chain,
      "task-1",
      "ws-1",
    );
    // Exercises the actual fn (not a mirror): it joins, filters, and returns rows.
    expect(chain.innerJoin).toHaveBeenCalled();
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(calls.where).toBeDefined();
    expect(result).toEqual(rows);
  });

  it("compiles the expected WHERE clause (type='error', task + workspace scope)", () => {
    // Reference SQL for the query above. This documents the intended shape and
    // catches a regression in the column/filter set; it is a sibling check to
    // the real-fn test above, not a stand-in for it.
    const { sql, params } = fakeDb
      .select()
      .from(taskMessage)
      .innerJoin(agentTaskQueue, eq(taskMessage.taskId, agentTaskQueue.id))
      .where(
        and(
          eq(taskMessage.taskId, "task-1"),
          eq(agentTaskQueue.workspaceId, "ws-1"),
          eq(taskMessage.type, "error"),
        ),
      )
      .orderBy(asc(taskMessage.seq))
      .toSQL();

    expect(sql).toContain('inner join "agent_task_queue"');
    expect(sql).toContain('"task_message"."task_id" = ?');
    expect(sql).toContain('"agent_task_queue"."workspace_id" = ?');
    expect(sql).toContain('"task_message"."type" = ?');
    expect(sql).toContain('order by "task_message"."seq" asc');
    expect(params).toEqual(["task-1", "ws-1", "error"]);
  });
});

describe("listTaskMessagesSince", () => {
  it("accepts (db, taskId, afterSeq)", () => {
    expect(taskMessageQueries.listTaskMessagesSince.length).toBe(3);
  });
});

