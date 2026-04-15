import { describe, it, expect, vi, afterEach } from "vitest";
import { fromApiTask } from "./types.js";
import type { TaskApi } from "@alook/shared";
import { PollResponseSchema } from "@alook/shared";
import { DaemonClient } from "./client.js";

// ---------------------------------------------------------------------------
// Schema-level validation tests
// ---------------------------------------------------------------------------

describe("PollResponseSchema validation", () => {
  it("parses valid response with tasks", () => {
    const raw = {
      tasks: [{
        id: "t1",
        agent_id: "a1",
        runtime_id: "r1",
        conversation_id: "c1",
        workspace_id: "w1",
        prompt: "do it",
        status: "dispatched",
        priority: 1,
        dispatched_at: "2024-01-01T00:00:00Z",
        started_at: null,
        completed_at: null,
        result: null,
        error: null,
        created_at: "2024-01-01T00:00:00Z",
        type: "user_dm_message",
        agent: { instructions: "help", name: "bot", runtime_config: {} },
      }],
    };

    const parsed = PollResponseSchema.parse(raw);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe("t1");
    expect(parsed.tasks[0].agent?.name).toBe("bot");
  });

  it("parses empty tasks array", () => {
    const parsed = PollResponseSchema.parse({ tasks: [] });
    expect(parsed.tasks).toEqual([]);
  });

  it("throws ZodError when tasks contains invalid items", () => {
    const raw = { tasks: [{ id: "t1" }] }; // missing required fields
    expect(() => PollResponseSchema.parse(raw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DaemonClient.poll() integration tests with mocked fetch
// ---------------------------------------------------------------------------

function validPollResponse() {
  return {
    tasks: [{
      id: "t1",
      agent_id: "a1",
      runtime_id: "r1",
      conversation_id: "c1",
      workspace_id: "w1",
      prompt: "do it",
      status: "dispatched",
      priority: 1,
      dispatched_at: "2024-01-01T00:00:00Z",
      started_at: null,
      completed_at: null,
      result: null,
      error: null,
      created_at: "2024-01-01T00:00:00Z",
      type: "user_dm_message",
    }],
  };
}

describe("DaemonClient.poll() with mocked fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct POST body with daemon_id to /api/daemon/tasks/poll", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ tasks: [] }),
    });

    const client = new DaemonClient("http://localhost:8080");
    await client.poll("tok", "d1", 3);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/daemon/tasks/poll",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ daemon_id: "d1", max_tasks: 3 }),
      }),
    );
  });

  it("passes token in Authorization header per-call", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ tasks: [] }),
    });

    const client = new DaemonClient("http://localhost:8080");
    await client.poll("my_token_123", "d1", 1);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my_token_123",
        }),
      }),
    );
  });

  it("returns TaskApi[] on valid response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(validPollResponse()),
    });

    const client = new DaemonClient("http://localhost:8080");
    const tasks = await client.poll("tok", "d1", 1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
  });

  it("returns empty array when no tasks", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ tasks: [] }),
    });

    const client = new DaemonClient("http://localhost:8080");
    const tasks = await client.poll("tok", "d1", 1);
    expect(tasks).toEqual([]);
  });

  it("throws ZodError when API returns wrong shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: "data" }),
    });

    const client = new DaemonClient("http://localhost:8080");
    await expect(client.poll("tok", "d1", 1)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DaemonClient.register() tests
// ---------------------------------------------------------------------------

describe("DaemonClient.register() with mocked fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns parsed RegisterResponse on valid response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ runtimes: [{ id: "rt1" }] }),
    });

    const client = new DaemonClient("http://localhost:8080");
    const resp = await client.register("tok", {
      workspace_id: "w1",
      daemon_id: "d1",
      device_name: "mac",
      cli_version: "1.0",
      runtimes: [{ name: "claude", type: "claude", version: "1.0", status: "online" }],
    });
    expect(resp.runtimes[0].id).toBe("rt1");
  });

  it("passes token in Authorization header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ runtimes: [{ id: "rt1" }] }),
    });

    const client = new DaemonClient("http://localhost:8080");
    await client.register("my_ws_token", {
      workspace_id: "w1",
      daemon_id: "d1",
      device_name: "mac",
      cli_version: "1.0",
      runtimes: [{ name: "claude", type: "claude", version: "1.0", status: "online" }],
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my_ws_token",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DaemonClient.deregister() tests
// ---------------------------------------------------------------------------

describe("DaemonClient.deregister() with mocked fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends daemon_id in body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });

    const client = new DaemonClient("http://localhost:8080");
    await client.deregister("tok", "d1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/daemon/deregister",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ daemon_id: "d1" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DaemonClient has no heartbeat() or claimTask() methods
// ---------------------------------------------------------------------------

describe("DaemonClient removed methods", () => {
  it("does not have heartbeat method", () => {
    const client = new DaemonClient("http://localhost:8080");
    expect((client as any).heartbeat).toBeUndefined();
  });

  it("does not have claimTask method", () => {
    const client = new DaemonClient("http://localhost:8080");
    expect((client as any).claimTask).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fromApiTask tests (unchanged)
// ---------------------------------------------------------------------------

function validApiTask(): TaskApi {
  return {
    id: "t1",
    agent_id: "a1",
    runtime_id: "r1",
    conversation_id: "c1",
    workspace_id: "w1",
    prompt: "do it",
    status: "dispatched",
    priority: 1,
    dispatched_at: "2024-01-01T00:00:00Z",
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2024-01-01T00:00:00Z",
    type: "user_dm_message",
    agent: { instructions: "help", name: "bot", runtime_config: {} },
  };
}

describe("fromApiTask", () => {
  it("correctly maps snake_case API response to camelCase Task", () => {
    const task = fromApiTask(validApiTask());
    expect(task.id).toBe("t1");
    expect(task.agentId).toBe("a1");
    expect(task.runtimeId).toBe("r1");
    expect(task.conversationId).toBe("c1");
    expect(task.workspaceId).toBe("w1");
    expect(task.prompt).toBe("do it");
    expect(task.status).toBe("dispatched");
    expect(task.priority).toBe(1);
    expect(task.type).toBe("user_dm_message");
    expect(task.agent?.name).toBe("bot");
    expect(task.agent?.instructions).toBe("help");
    expect(task.createdAt).toBe("2024-01-01T00:00:00Z");
  });

  it("handles missing repos field (defaults to undefined)", () => {
    const task = fromApiTask(validApiTask());
    expect(task.repos).toBeUndefined();
  });

  it("handles missing agent.id field (optional in API)", () => {
    const api = validApiTask();
    const task = fromApiTask(api);
    expect(task.agent?.id).toBeUndefined();
    expect(task.agent?.name).toBe("bot");
  });
});
