import { describe, it, expect } from "vitest";
import { taskToResponse, messageToResponse } from "./responses";

const ts = new Date("2024-06-01T12:00:00.456Z");
const tsFormatted = "2024-06-01T12:00:00Z";

function baseFields(overrides: Record<string, unknown> = {}) {
  return { createdAt: ts, updatedAt: ts, ...overrides };
}

describe("taskToResponse", () => {
  const taskBase = {
    id: "t1",
    agentId: "a1",
    runtimeId: "r1",
    conversationId: "c1",
    workspaceId: "w1",
    prompt: "Do it",
    status: "completed",
    priority: 1,
    ...baseFields(),
  };

  it("returns null for null result", () => {
    const res = taskToResponse({ ...taskBase, result: null, error: null, dispatchedAt: null, startedAt: null, completedAt: null });
    expect(res.result).toBeNull();
  });

  it("returns null for undefined error", () => {
    const res = taskToResponse({ ...taskBase, result: "ok", dispatchedAt: null, startedAt: null, completedAt: null });
    expect(res.error).toBeNull();
  });

  it("returns null for null dispatched_at, started_at, completed_at", () => {
    const res = taskToResponse({ ...taskBase, result: null, error: null, dispatchedAt: null, startedAt: null, completedAt: null });
    expect(res.dispatched_at).toBeNull();
    expect(res.started_at).toBeNull();
    expect(res.completed_at).toBeNull();
  });

  it("formats dispatched_at/started_at/completed_at when present", () => {
    const res = taskToResponse({ ...taskBase, result: null, error: null, dispatchedAt: ts, startedAt: ts, completedAt: ts });
    expect(res.dispatched_at).toBe(tsFormatted);
    expect(res.started_at).toBe(tsFormatted);
    expect(res.completed_at).toBe(tsFormatted);
  });
});

describe("taskToResponse Zod validation", () => {
  const validTask = {
    id: "t1",
    agentId: "a1",
    runtimeId: "r1",
    conversationId: "c1",
    workspaceId: "w1",
    prompt: "Do it",
    status: "running",
    priority: 1,
    result: null,
    error: null,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: ts,
  };

  it("throws when given object with missing id", () => {
    const { id, ...noId } = validTask;
    expect(() => taskToResponse(noId as any)).toThrow();
  });

  it("throws when priority is not a number", () => {
    expect(() =>
      taskToResponse({ ...validTask, priority: "high" } as any),
    ).toThrow();
  });

  it("preserves context field in output", () => {
    const withContext = { ...validTask, context: { attachment_ids: ["art_1"] } };
    const res = taskToResponse(withContext as any);
    expect(res.context).toEqual({ attachment_ids: ["art_1"] });
  });

  it("produces snake_case keys in output", () => {
    const res = taskToResponse(validTask);
    expect(res).toHaveProperty("agent_id");
    expect(res).toHaveProperty("runtime_id");
    expect(res).toHaveProperty("conversation_id");
    expect(res).toHaveProperty("workspace_id");
    expect(res).toHaveProperty("created_at");
    expect(res).not.toHaveProperty("agentId");
    expect(res).not.toHaveProperty("runtimeId");
  });
});

describe("messageToResponse", () => {
  it("returns null for null task_id", () => {
    const res = messageToResponse({ id: "m1", conversationId: "c1", role: "user", content: "hi", taskId: null, createdAt: ts });
    expect(res.task_id).toBeNull();
  });

  it("returns null for undefined task_id", () => {
    const res = messageToResponse({ id: "m1", conversationId: "c1", role: "user", content: "hi", createdAt: ts });
    expect(res.task_id).toBeNull();
  });
});
