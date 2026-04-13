import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fromApiTask } from "./types.js";
import type { TaskApi } from "@alook/shared";
import { ClaimTaskResponseSchema } from "@alook/shared";
import { DaemonClient } from "./client.js";

// ---------------------------------------------------------------------------
// Schema-level validation tests (existing)
// ---------------------------------------------------------------------------

describe("DaemonClient claimTask schema validation", () => {
  it("parses valid response correctly", () => {
    const raw = {
      task: {
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
        agent: { instructions: "help", name: "bot", runtime_config: {} },
        prior_session_id: "sess-0",
      },
    };

    const parsed = ClaimTaskResponseSchema.parse(raw);
    expect(parsed.task?.id).toBe("t1");
    expect(parsed.task?.agent?.name).toBe("bot");
  });

  it("throws ZodError when response is missing required fields", () => {
    const raw = {
      task: {
        id: "t1",
        // missing agent_id, runtime_id, etc.
      },
    };

    expect(() => ClaimTaskResponseSchema.parse(raw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DaemonClient integration tests with mocked fetch
// ---------------------------------------------------------------------------

function validClaimResponse() {
  return {
    task: {
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
    },
  };
}

describe("DaemonClient.claimTask() with mocked fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns parsed ClaimTaskResponse on valid response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(validClaimResponse()),
    });

    const client = new DaemonClient("http://localhost:8080", "tok");
    const resp = await client.claimTask("r1");
    expect(resp.task?.id).toBe("t1");
    expect(resp.task?.agent_id).toBe("a1");
  });

  it("throws ZodError when API returns response with wrong shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ task: { id: "t1" } }), // missing required fields
    });

    const client = new DaemonClient("http://localhost:8080", "tok");
    await expect(client.claimTask("r1")).rejects.toThrow();
  });

  it("returns { task: null } when no task available", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ task: null }),
    });

    const client = new DaemonClient("http://localhost:8080", "tok");
    const resp = await client.claimTask("r1");
    expect(resp.task).toBeNull();
  });
});

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

    const client = new DaemonClient("http://localhost:8080", "tok");
    const resp = await client.register({
      workspace_id: "w1",
      daemon_id: "d1",
      device_name: "mac",
      cli_version: "1.0",
      runtimes: [{ name: "claude", type: "claude", version: "1.0", status: "online" }],
    });
    expect(resp.runtimes[0].id).toBe("rt1");
  });

  it("throws ZodError when API returns unexpected shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: "data" }),
    });

    const client = new DaemonClient("http://localhost:8080", "tok");
    await expect(
      client.register({
        workspace_id: "w1",
        daemon_id: "d1",
        device_name: "mac",
        cli_version: "1.0",
        runtimes: [{ name: "claude", type: "claude", version: "1.0", status: "online" }],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fromApiTask tests
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
    agent: { instructions: "help", name: "bot", runtime_config: {} },
    prior_session_id: "sess-0",
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
    expect(task.agent?.name).toBe("bot");
    expect(task.agent?.instructions).toBe("help");
    expect(task.priorSessionId).toBe("sess-0");
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
