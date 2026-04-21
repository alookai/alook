import { describe, it, expect } from "vitest";
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
});

describe("task query function signatures", () => {
  it("listActiveTaskCountsByWorkspace accepts (db, workspaceId)", () => {
    expect(taskQueries.listActiveTaskCountsByWorkspace.length).toBe(2);
  });

  it("listActiveTasksByAgent accepts (db, agentId, workspaceId)", () => {
    expect(taskQueries.listActiveTasksByAgent.length).toBe(3);
  });
});
