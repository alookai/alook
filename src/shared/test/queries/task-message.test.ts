import { describe, it, expect } from "vitest";
import * as taskMessageQueries from "../../src/db/queries/task-message";

describe("task-message query module exports", () => {
  it("exports createTaskMessage", () => {
    expect(typeof taskMessageQueries.createTaskMessage).toBe("function");
  });

  it("exports listTaskMessages", () => {
    expect(typeof taskMessageQueries.listTaskMessages).toBe("function");
  });

  it("exports listTaskMessagesSince", () => {
    expect(typeof taskMessageQueries.listTaskMessagesSince).toBe("function");
  });

  it("exports deleteTaskMessages", () => {
    expect(typeof taskMessageQueries.deleteTaskMessages).toBe("function");
  });

  it("exports countTaskMessagesByTaskIds", () => {
    expect(typeof taskMessageQueries.countTaskMessagesByTaskIds).toBe("function");
  });
});

describe("listTaskMessages", () => {
  it("accepts (db, taskId, workspaceId?)", () => {
    expect(taskMessageQueries.listTaskMessages.length).toBe(3);
  });
});

describe("listTaskMessagesSince", () => {
  it("accepts (db, taskId, afterSeq)", () => {
    expect(taskMessageQueries.listTaskMessagesSince.length).toBe(3);
  });
});

describe("countTaskMessagesByTaskIds", () => {
  it("accepts (db, taskIds, workspaceId)", () => {
    expect(taskMessageQueries.countTaskMessagesByTaskIds.length).toBe(3);
  });

  it("returns empty array for empty taskIds input", async () => {
    const mockDb = {} as Parameters<typeof taskMessageQueries.countTaskMessagesByTaskIds>[0];
    const result = await taskMessageQueries.countTaskMessagesByTaskIds(mockDb, [], "ws-1");
    expect(result).toEqual([]);
  });
});
