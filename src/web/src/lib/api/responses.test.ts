import { describe, it, expect } from "vitest";
import {
  userToResponse,
  workspaceToResponse,
  agentToResponse,
  taskToResponse,
  conversationToResponse,
  messageToResponse,
  runtimeToResponse,
  machineTokenToResponse,
  emailToResponse,
} from "./responses";

const ts = new Date("2024-06-01T12:00:00.456Z");
const tsFormatted = "2024-06-01T12:00:00Z";

function baseFields(overrides: Record<string, unknown> = {}) {
  return { createdAt: ts, updatedAt: ts, ...overrides };
}

describe("agentToResponse", () => {
  it("defaults runtime_config to {} when null", () => {
    const res = agentToResponse({
      id: "a1",
      workspaceId: "w1",
      runtimeId: null,
      name: "Agent",
      description: "desc",
      instructions: "inst",
      runtimeMode: "auto",
      runtimeConfig: null,
      status: "active",
      maxConcurrentTasks: 1,
      ...baseFields(),
    });
    expect(res.runtime_config).toEqual({});
  });

  it("preserves runtime_config when present", () => {
    const cfg = { model: "gpt-4" };
    const res = agentToResponse({
      id: "a1",
      workspaceId: "w1",
      runtimeId: "r1",
      name: "Agent",
      description: "desc",
      instructions: "inst",
      runtimeMode: "auto",
      runtimeConfig: cfg,
      status: "active",
      maxConcurrentTasks: 1,
      ...baseFields(),
    });
    expect(res.runtime_config).toEqual(cfg);
  });

  it("returns empty string when runtime_id is null", () => {
    const res = agentToResponse({
      id: "a1",
      workspaceId: "w1",
      runtimeId: null,
      name: "Agent",
      description: "d",
      instructions: "i",
      runtimeMode: "auto",
      runtimeConfig: {},
      status: "active",
      maxConcurrentTasks: 1,
      ...baseFields(),
    });
    expect(res.runtime_id).toBe("");
  });

  it("returns empty string when runtime_id is undefined", () => {
    const res = agentToResponse({
      id: "a1",
      workspaceId: "w1",
      name: "Agent",
      description: "d",
      instructions: "i",
      runtimeMode: "auto",
      runtimeConfig: {},
      status: "active",
      maxConcurrentTasks: 1,
      ...baseFields(),
    });
    expect(res.runtime_id).toBe("");
  });
});

describe("runtimeToResponse", () => {
  it("defaults metadata to {} when null", () => {
    const res = runtimeToResponse({
      id: "rt1",
      workspaceId: "w1",
      daemonId: null,
      name: "Rt",
      runtimeMode: "docker",
      provider: "local",
      status: "online",
      deviceInfo: "mac",
      metadata: null,
      lastSeenAt: null,
      ...baseFields(),
    });
    expect(res.metadata).toEqual({});
  });

  it("returns null when daemon_id is null", () => {
    const res = runtimeToResponse({
      id: "rt1",
      workspaceId: "w1",
      daemonId: null,
      name: "Rt",
      runtimeMode: "docker",
      provider: "local",
      status: "online",
      deviceInfo: "mac",
      metadata: {},
      lastSeenAt: null,
      ...baseFields(),
    });
    expect(res.daemon_id).toBeNull();
  });

  it("returns null when daemon_id is undefined", () => {
    const res = runtimeToResponse({
      id: "rt1",
      workspaceId: "w1",
      name: "Rt",
      runtimeMode: "docker",
      provider: "local",
      status: "online",
      deviceInfo: "mac",
      metadata: {},
      lastSeenAt: null,
      ...baseFields(),
    });
    expect(res.daemon_id).toBeNull();
  });
});

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

  it("strips context field from output", () => {
    const withContext = { ...validTask, context: { secret: true } };
    const res = taskToResponse(withContext as any);
    expect("context" in res).toBe(false);
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

describe("machineTokenToResponse", () => {
  it("returns null for null last_used_at", () => {
    const res = machineTokenToResponse({ id: "mt1", name: "Token", lastUsedAt: null, createdAt: ts });
    expect(res.last_used_at).toBeNull();
  });

  it("formats last_used_at when present", () => {
    const res = machineTokenToResponse({ id: "mt1", name: "Token", lastUsedAt: ts, createdAt: ts });
    expect(res.last_used_at).toBe(tsFormatted);
  });
});

describe("UserResponse shape", () => {
  it("has expected keys: id, name, email, avatar_url, created_at, updated_at", () => {
    const res = userToResponse({ id: "u1", name: "A", email: "a@b.com", avatarUrl: "https://img.png", ...baseFields() });
    expect(Object.keys(res).sort()).toEqual(
      ["avatar_url", "created_at", "email", "id", "name", "updated_at"]
    );
    expect(res).toEqual({
      id: "u1",
      name: "A",
      email: "a@b.com",
      avatar_url: "https://img.png",
      created_at: tsFormatted,
      updated_at: tsFormatted,
    });
  });
});

describe("WorkspaceResponse shape", () => {
  it("has expected keys: id, name, slug, created_at, updated_at", () => {
    const res = workspaceToResponse({ id: "w1", name: "WS", slug: "ws", ...baseFields() });
    expect(Object.keys(res).sort()).toEqual(
      ["created_at", "id", "name", "slug", "updated_at"]
    );
  });
});

describe("AgentResponse shape", () => {
  it("has expected keys", () => {
    const res = agentToResponse({
      id: "a1", workspaceId: "w1", runtimeId: "r1", name: "A", description: "d",
      instructions: "i", runtimeMode: "auto", runtimeConfig: {}, status: "active",
      maxConcurrentTasks: 3, ...baseFields(),
    });
    expect(Object.keys(res).sort()).toEqual([
      "created_at", "description", "email_handle", "id", "instructions", "max_concurrent_tasks",
      "name", "runtime_config", "runtime_id", "runtime_mode", "status",
      "updated_at", "workspace_id",
    ]);
  });
});

describe("ConversationResponse shape", () => {
  it("has expected keys: id, agent_id, title, created_at", () => {
    const res = conversationToResponse({ id: "c1", agentId: "a1", title: "Chat", createdAt: ts });
    expect(Object.keys(res).sort()).toEqual(["agent_id", "created_at", "id", "title"]);
  });
});

describe("MessageResponse shape", () => {
  it("has expected keys: id, conversation_id, role, content, task_id, created_at", () => {
    const res = messageToResponse({ id: "m1", conversationId: "c1", role: "user", content: "hi", taskId: "t1", createdAt: ts });
    expect(Object.keys(res).sort()).toEqual(
      ["content", "conversation_id", "created_at", "id", "role", "task_id"]
    );
  });
});

describe("MachineTokenResponse shape", () => {
  it("has expected keys: id, name, last_used_at, created_at", () => {
    const res = machineTokenToResponse({ id: "mt1", name: "Token", lastUsedAt: ts, createdAt: ts });
    expect(Object.keys(res).sort()).toEqual(["created_at", "id", "last_used_at", "name"]);
  });
});

describe("AgentRuntimeResponse shape", () => {
  it("has expected keys", () => {
    const res = runtimeToResponse({
      id: "rt1", workspaceId: "w1", daemonId: "d1", name: "Rt", runtimeMode: "docker",
      provider: "local", status: "online", deviceInfo: "mac", metadata: { foo: 1 },
      lastSeenAt: ts, ...baseFields(),
    });
    expect(Object.keys(res).sort()).toEqual([
      "created_at", "daemon_id", "device_info", "id", "last_seen_at",
      "metadata", "name", "provider", "runtime_mode", "status",
      "updated_at", "workspace_id",
    ]);
  });
});

describe("all response mappers strip milliseconds from timestamps", () => {
  it("userToResponse strips milliseconds", () => {
    const res = userToResponse({ id: "u1", name: "A", email: "a@b.com", avatarUrl: null, ...baseFields() });
    expect(res.created_at).toBe(tsFormatted);
    expect(res.updated_at).toBe(tsFormatted);
  });

  it("workspaceToResponse strips milliseconds", () => {
    const res = workspaceToResponse({ id: "w1", name: "WS", slug: "ws", ...baseFields() });
    expect(res.created_at).toBe(tsFormatted);
    expect(res.updated_at).toBe(tsFormatted);
  });

  it("agentToResponse strips milliseconds", () => {
    const res = agentToResponse({
      id: "a1", workspaceId: "w1", runtimeId: "r1", name: "A", description: "d",
      instructions: "i", runtimeMode: "auto", runtimeConfig: {}, status: "active",
      maxConcurrentTasks: 1, ...baseFields(),
    });
    expect(res.created_at).toBe(tsFormatted);
    expect(res.updated_at).toBe(tsFormatted);
  });

  it("conversationToResponse strips milliseconds", () => {
    const res = conversationToResponse({ id: "c1", agentId: "a1", title: "Chat", createdAt: ts });
    expect(res.created_at).toBe(tsFormatted);
  });

  it("runtimeToResponse strips milliseconds", () => {
    const res = runtimeToResponse({
      id: "rt1", workspaceId: "w1", daemonId: "d1", name: "Rt", runtimeMode: "docker",
      provider: "local", status: "online", deviceInfo: "mac", metadata: {},
      lastSeenAt: ts, ...baseFields(),
    });
    expect(res.created_at).toBe(tsFormatted);
    expect(res.updated_at).toBe(tsFormatted);
    expect(res.last_seen_at).toBe(tsFormatted);
  });

  it("machineTokenToResponse strips milliseconds", () => {
    const res = machineTokenToResponse({ id: "mt1", name: "T", lastUsedAt: ts, createdAt: ts });
    expect(res.created_at).toBe(tsFormatted);
    expect(res.last_used_at).toBe(tsFormatted);
  });
});

describe("emailToResponse", () => {
  it("maps DB fields to API response format", () => {
    const res = emailToResponse({
      id: "e1",
      agentId: "a1",
      fromEmail: "alice@example.com",
      toEmail: "agent@alook.ai",
      subject: "Hello",
      r2Key: "emails/abc/raw",
      isWhitelisted: 1,
      forwarded: 0,

      htmlBody: "<p>Hi</p>",
      attachments: "[]",
      createdAt: ts,
    });
    expect(res.id).toBe("e1");
    expect(res.agent_id).toBe("a1");
    expect(res.from_email).toBe("alice@example.com");
    expect(res.is_whitelisted).toBe(true);
    expect(res.forwarded).toBe(false);

    expect(res.attachments).toEqual([]);
    expect(res.created_at).toBe(tsFormatted);
  });

  it("parses attachments JSON string", () => {
    const attachments = [{ key: "k1", filename: "f.pdf", size: 100, contentType: "application/pdf" }];
    const res = emailToResponse({
      id: "e2",
      agentId: "a1",
      fromEmail: "a@b.com",
      toEmail: "c@d.com",
      subject: "S",
      r2Key: "r",
      isWhitelisted: 0,
      forwarded: 0,

      htmlBody: "",
      attachments: JSON.stringify(attachments),
      createdAt: ts,
    });
    expect(res.attachments).toEqual(attachments);
    expect(res.attachments[0].filename).toBe("f.pdf");
  });

  it("defaults to empty array when attachments is null/empty", () => {
    const res = emailToResponse({
      id: "e3", agentId: "a1", fromEmail: "a@b.com", toEmail: "c@d.com",
      subject: "S", r2Key: "r", isWhitelisted: 0, forwarded: 0,
      htmlBody: "", attachments: "",
      createdAt: ts,
    });
    expect(res.attachments).toEqual([]);
  });
});
