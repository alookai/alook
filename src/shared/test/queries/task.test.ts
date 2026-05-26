import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as taskQueries from "../../src/db/queries/task";

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

  it("exports beginTaskApply", () => {
    expect(typeof taskQueries.beginTaskApply).toBe("function");
  });
});

describe("task query function signatures", () => {
  it("listActiveTaskCountsByWorkspace accepts (db, workspaceId)", () => {
    expect(taskQueries.listActiveTaskCountsByWorkspace.length).toBe(2);
  });

  it("listActiveTasksByAgent accepts (db, agentId, workspaceId)", () => {
    expect(taskQueries.listActiveTasksByAgent.length).toBe(3);
  });
});

describe("task active status model", () => {
  it("uses shared active/executing status constants in active and stale queries", () => {
    const src = readFileSync(join(__dirname, "../../src/db/queries/task.ts"), "utf8");

    expect(src).toContain("ACTIVE_TASK_STATUSES");
    expect(src).toContain("EXECUTING_TASK_STATUSES");
    expect(src).toContain("RUNNING_TASK_STATUSES");
    expect(src).toContain("inArray(agentTaskQueue.status, [...ACTIVE_TASK_STATUSES])");
    expect(src).toContain("inArray(agentTaskQueue.status, [...EXECUTING_TASK_STATUSES])");
    expect(src).toContain("inArray(agentTaskQueue.status, [...RUNNING_TASK_STATUSES])");
  });
});
