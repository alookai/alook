import { describe, it, expect } from "vitest";
import {
  TaskStatusSchema,
  ClaimedTaskRowSchema,
  TaskApiBaseSchema,
  TaskApiSchema,
  TaskAgentDataApiSchema,
  PollRequestSchema,
  PollResponseSchema,
  RegisterDaemonRequestSchema,
  DaemonRuntimeItemSchema,
  DeregisterRequestSchema,
  CompleteTaskRequestSchema,
  FailTaskRequestSchema,
  ReportMessagesRequestSchema,
} from "./schemas";

// ---------------------------------------------------------------------------
// TaskStatusSchema
// ---------------------------------------------------------------------------

describe("TaskStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const s of ["queued", "dispatched", "running", "completed", "failed", "cancelled"]) {
      expect(TaskStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects invalid status strings", () => {
    expect(() => TaskStatusSchema.parse("pending")).toThrow();
    expect(() => TaskStatusSchema.parse("unknown")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ClaimedTaskRowSchema
// ---------------------------------------------------------------------------

function validRow() {
  return {
    id: "t1",
    agentId: "a1",
    runtimeId: "r1",
    workspaceId: "w1",
    conversationId: "c1",
    prompt: "do something",
    type: "user_dm_message",
    status: "dispatched",
    priority: 5,
    result: null,
    context: { foo: "bar" },
    sessionId: "sess-1",
    createdAt: "2024-01-01T00:00:00Z",
    dispatchedAt: "2024-01-01T00:01:00Z",
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

describe("ClaimedTaskRowSchema", () => {
  it("parses a valid raw SQL row with all columns", () => {
    const row = validRow();
    const parsed = ClaimedTaskRowSchema.parse(row);
    expect(parsed.id).toBe("t1");
    expect(parsed.context).toEqual({ foo: "bar" });
    expect(parsed.sessionId).toBe("sess-1");
  });

  it("coerces string timestamps to Date objects", () => {
    const parsed = ClaimedTaskRowSchema.parse(validRow());
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.dispatchedAt).toBeInstanceOf(Date);
  });

  it("throws on missing runtime_id field", () => {
    const row = validRow();
    delete (row as any).runtimeId;
    expect(() => ClaimedTaskRowSchema.parse(row)).toThrow();
  });

  it("throws on wrong type (e.g., runtimeId: 123)", () => {
    const row = { ...validRow(), runtimeId: 123 };
    expect(() => ClaimedTaskRowSchema.parse(row)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TaskApiBaseSchema
// ---------------------------------------------------------------------------

function validTaskApiBase() {
  return {
    id: "t1",
    agent_id: "a1",
    runtime_id: "r1",
    conversation_id: "c1",
    workspace_id: "w1",
    prompt: "do something",
    status: "dispatched",
    priority: 5,
    dispatched_at: "2024-01-01T00:01:00Z",
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2024-01-01T00:00:00Z",
    type: "user_dm_message",
  };
}

describe("TaskApiBaseSchema", () => {
  it("parses a valid task response with string timestamps", () => {
    const parsed = TaskApiBaseSchema.parse(validTaskApiBase());
    expect(parsed.id).toBe("t1");
    expect(parsed.priority).toBe(5);
  });

  it("does not include context field", () => {
    const input = { ...validTaskApiBase(), context: { foo: "bar" } };
    const parsed = TaskApiBaseSchema.parse(input);
    expect("context" in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskApiSchema
// ---------------------------------------------------------------------------

describe("TaskApiSchema", () => {
  it("accepts optional agent", () => {
    const input = {
      ...validTaskApiBase(),
      agent: { instructions: "be helpful", name: "bot", runtime_config: {} },
    };
    const parsed = TaskApiSchema.parse(input);
    expect(parsed.agent?.name).toBe("bot");
  });
});

// ---------------------------------------------------------------------------
// TaskAgentDataApiSchema
// ---------------------------------------------------------------------------

describe("TaskAgentDataApiSchema", () => {
  it("does not require id field", () => {
    const parsed = TaskAgentDataApiSchema.parse({
      instructions: "help",
      name: "bot",
    });
    expect(parsed.name).toBe("bot");
    expect(parsed.runtime_config).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// PollRequestSchema
// ---------------------------------------------------------------------------

describe("PollRequestSchema", () => {
  it("accepts daemon_id and defaults max_tasks to 1", () => {
    const parsed = PollRequestSchema.parse({ daemon_id: "d1" });
    expect(parsed.daemon_id).toBe("d1");
    expect(parsed.max_tasks).toBe(1);
  });

  it("rejects missing daemon_id", () => {
    expect(() => PollRequestSchema.parse({})).toThrow();
  });

  it("rejects empty daemon_id", () => {
    expect(() => PollRequestSchema.parse({ daemon_id: "" })).toThrow();
  });

  it("rejects max_tasks: 0", () => {
    expect(() => PollRequestSchema.parse({ daemon_id: "d1", max_tasks: 0 })).toThrow();
  });

  it("rejects old-format body with runtime_ids", () => {
    // runtime_ids is no longer recognized — daemon_id is required
    expect(() => PollRequestSchema.parse({ runtime_ids: ["r1"] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PollResponseSchema
// ---------------------------------------------------------------------------

describe("PollResponseSchema", () => {
  it("accepts empty tasks array", () => {
    const parsed = PollResponseSchema.parse({ tasks: [] });
    expect(parsed.tasks).toEqual([]);
  });

  it("accepts tasks with valid task objects", () => {
    const parsed = PollResponseSchema.parse({
      tasks: [validTaskApiBase()],
    });
    expect(parsed.tasks[0].id).toBe("t1");
  });
});

// ---------------------------------------------------------------------------
// RegisterDaemonRequestSchema
// ---------------------------------------------------------------------------

describe("RegisterDaemonRequestSchema", () => {
  it("requires workspace_id and daemon_id (min length 1)", () => {
    expect(() =>
      RegisterDaemonRequestSchema.parse({
        workspace_id: "",
        daemon_id: "d1",
        runtimes: [{}],
      }),
    ).toThrow();

    expect(() =>
      RegisterDaemonRequestSchema.parse({
        workspace_id: "w1",
        daemon_id: "",
        runtimes: [{}],
      }),
    ).toThrow();
  });

  it("requires at least one runtime in array", () => {
    expect(() =>
      RegisterDaemonRequestSchema.parse({
        workspace_id: "w1",
        daemon_id: "d1",
        runtimes: [],
      }),
    ).toThrow();
  });

  it("defaults device_name and cli_version to empty string", () => {
    const parsed = RegisterDaemonRequestSchema.parse({
      workspace_id: "w1",
      daemon_id: "d1",
      runtimes: [{ type: "claude" }],
    });
    expect(parsed.device_name).toBe("");
    expect(parsed.cli_version).toBe("");
  });
});

// ---------------------------------------------------------------------------
// DaemonRuntimeItemSchema
// ---------------------------------------------------------------------------

describe("DaemonRuntimeItemSchema", () => {
  it("accepts all fields as optional strings", () => {
    const parsed = DaemonRuntimeItemSchema.parse({});
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DeregisterRequestSchema
// ---------------------------------------------------------------------------

describe("DeregisterRequestSchema", () => {
  it("accepts daemon_id (string, min 1)", () => {
    const parsed = DeregisterRequestSchema.parse({ daemon_id: "d1" });
    expect(parsed.daemon_id).toBe("d1");
  });

  it("rejects missing daemon_id", () => {
    expect(() => DeregisterRequestSchema.parse({})).toThrow();
  });

  it("rejects empty daemon_id", () => {
    expect(() => DeregisterRequestSchema.parse({ daemon_id: "" })).toThrow();
  });
});


// ---------------------------------------------------------------------------
// CompleteTaskRequestSchema
// ---------------------------------------------------------------------------

describe("CompleteTaskRequestSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    const parsed = CompleteTaskRequestSchema.parse({});
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FailTaskRequestSchema
// ---------------------------------------------------------------------------

describe("FailTaskRequestSchema", () => {
  it("defaults error to empty string when missing", () => {
    const parsed = FailTaskRequestSchema.parse({});
    expect(parsed.error).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ReportMessagesRequestSchema
// ---------------------------------------------------------------------------

describe("ReportMessagesRequestSchema", () => {
  it("requires seq (number) and type (string) in each message item", () => {
    const parsed = ReportMessagesRequestSchema.parse({
      messages: [{ seq: 1, type: "text" }],
    });
    expect(parsed.messages[0].seq).toBe(1);

    expect(() =>
      ReportMessagesRequestSchema.parse({
        messages: [{ type: "text" }],
      }),
    ).toThrow();

    expect(() =>
      ReportMessagesRequestSchema.parse({
        messages: [{ seq: 1 }],
      }),
    ).toThrow();
  });
});
