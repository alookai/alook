import { describe, it, expect } from "vitest";
import { buildPrompt, buildTaskObject, buildMergedPrompt } from "./prompt.js";
import { localISOString } from "./execenv/timeline.js";
import type { Task } from "./types.js";

function makeTask(prompt: string, type = "user_dm_message"): Task {
  return {
    id: "t1",
    agentId: "a1",
    runtimeId: "r1",
    conversationId: "c1",
    workspaceId: "w1",
    prompt,
    type,
    status: "pending",
    priority: 1,
    createdAt: new Date().toISOString(),
    traceId: null,
    parentTaskId: null,
    channel: null,
  };
}

describe("buildPrompt", () => {
  it("returns structured JSON with type and instruction", () => {
    const task = makeTask("Fix the login bug");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.type).toBe("user_dm_message");
    expect(parsed.instruction).toBe("Fix the login bug");
  });

  it("handles empty prompt", () => {
    const task = makeTask("");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.type).toBe("user_dm_message");
    expect(parsed.instruction).toBe("");
  });

  it("includes the task type in output", () => {
    const task = makeTask("Check inbox", "email_inbound");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.type).toBe("email_inbound");
    expect(parsed.instruction).toBe("Check inbox");
    expect(buildPrompt(task)).toBe(
      JSON.stringify({
        type: "email_inbound",
        received_at: parsed.received_at,
        instruction: "Check inbox",
      }),
    );
  });

  it("stamps received_at from createdAt, matching localISOString", () => {
    const task = makeTask("Hi");
    task.createdAt = "2026-06-04T14:12:33.000Z";
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.received_at).toBe(localISOString(new Date(task.createdAt)));
    // Round-trip to the same instant, avoiding brittle tz-string assertions on CI.
    expect(new Date(parsed.received_at).getTime()).toBe(Date.parse(task.createdAt));
  });

  it("stamps received_at for every input source", () => {
    for (const type of [
      "user_dm_message",
      "email_notification",
      "calendar_event",
      "issue_event",
    ]) {
      const parsed = JSON.parse(buildPrompt(makeTask("x", type)));
      expect(typeof parsed.received_at).toBe("string");
      expect(parsed.received_at).not.toBe("");
    }
  });

  it("keeps calendar datetime (scheduled) distinct from received_at (arrival)", () => {
    const task: Task = {
      ...makeTask("scheduled task", "calendar_event"),
      createdAt: "2026-06-04T14:12:33.000Z",
      context: { datetime: "2026-06-10T09:00" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.datetime).toBe("2026-06-10T09:00");
    expect(parsed.received_at).toBe(localISOString(new Date("2026-06-04T14:12:33.000Z")));
    expect(parsed.received_at).not.toBe(parsed.datetime);
  });

  it("falls back to a valid current time when createdAt is invalid", () => {
    const task = makeTask("Hi");
    task.createdAt = "";
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.received_at).not.toBe("");
    expect(Number.isNaN(Date.parse(parsed.received_at))).toBe(false);
  });

  it("adds EMAIL_NOTICE for email_notification tasks without context", () => {
    const task = makeTask("New email from a@b.com: Hi", "email_notification");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("triggered by an incoming email");
    expect(parsed.notice).toContain("email sending tool");
    expect(parsed.notice).toContain("email them and then exit");
    expect(parsed.notice).toContain("new task will be triggered automatically");
  });

  it("adds EMAIL_NOTICE when conversationType is email_notification", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "email_notification" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("Reply to the sender via email");
  });

  it("adds DM_NOTICE when conversationType is user_dm_message with dmUser", () => {
    const task: Task = {
      ...makeTask("New email from bob@b.com: Review this", "email_notification"),
      context: { conversationType: "user_dm_message", dmUser: { name: "Alice", email: "alice@example.com" } },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("Alice");
    expect(parsed.notice).toContain("alice@example.com");
    expect(parsed.notice).toContain("reply to them directly");
    expect(parsed.notice).not.toContain("Reply to the sender via email");
  });

  it("falls back to EMAIL_NOTICE when conversationType is user_dm_message but dmUser is missing", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "user_dm_message" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("Reply to the sender via email");
  });

  it("falls back to EMAIL_NOTICE when conversationType is undefined in context", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { someOtherField: "value" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("Reply to the sender via email");
  });

  it("adds DM_RESPONSE_NOTICE for user_dm_message tasks", () => {
    const task = makeTask("Fix the bug", "user_dm_message");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("sync send-dm");
    expect(parsed.notice).toContain("at milestones");
    expect(parsed.notice).not.toContain("final text response is visible to the user");
  });

  it("adds CALENDAR_NOTICE for calendar_event tasks with no context", () => {
    const task = makeTask("Do the standup", "calendar_event");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.notice).toContain("send an email");
    expect(parsed.notice).toContain("email sending tool");
    expect(parsed.description).toBeUndefined();
    expect(parsed.scheduled_by).toBeUndefined();
  });

  it("includes description and scheduled_by for calendar_event with full context", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: {
        event_id: "ce_1",
        datetime: "2026-04-17T09:00:00.000Z",
        is_recurring: true,
        repeat_interval: "1day",
        description: "Check PRs merged this week",
        scheduled_by: { name: "Gus", email: "gus@memodb.io" },
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.event_id).toBe("ce_1");
    expect(parsed.datetime).toBe("2026-04-17T09:00:00.000Z");
    expect(parsed.is_recurring).toBe(true);
    expect(parsed.repeat_interval).toBe("1day");
    expect(parsed.description).toBe("Check PRs merged this week");
    expect(parsed.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
  });

  it("includes only description for calendar_event when scheduled_by is absent", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: {
        event_id: "ce_1",
        datetime: "2026-04-17T09:00:00.000Z",
        is_recurring: false,
        repeat_interval: null,
        description: "Check PRs merged this week",
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBe("Check PRs merged this week");
    expect(parsed.scheduled_by).toBeUndefined();
  });

  it("includes only scheduled_by for calendar_event when description is absent", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: {
        event_id: "ce_2",
        datetime: "2026-04-17T09:00:00.000Z",
        is_recurring: false,
        repeat_interval: null,
        scheduled_by: { name: "Gus", email: "gus@memodb.io" },
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBeUndefined();
    expect(parsed.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
  });

  it("omits description for calendar_event when description is empty string", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: {
        event_id: "ce_3",
        datetime: "2026-04-17T09:00:00.000Z",
        is_recurring: false,
        repeat_interval: null,
        description: "",
        scheduled_by: { name: "Gus", email: "gus@memodb.io" },
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBeUndefined();
    expect(parsed.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
  });

  it("forwards is_recurring=false and repeat_interval=null for one-off calendar events", () => {
    const task: Task = {
      ...makeTask("One-off reminder", "calendar_event"),
      context: {
        event_id: "ce_4",
        datetime: "2026-05-01T14:00:00.000Z",
        is_recurring: false,
        repeat_interval: null,
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.event_id).toBe("ce_4");
    expect(parsed.datetime).toBe("2026-05-01T14:00:00.000Z");
    expect(parsed.is_recurring).toBe(false);
    expect(parsed.repeat_interval).toBeNull();
  });

  it("forwards is_recurring=true and repeat_interval for recurring calendar events", () => {
    const task: Task = {
      ...makeTask("Weekly sync", "calendar_event"),
      context: {
        event_id: "ce_5",
        datetime: "2026-05-05T10:00:00.000Z",
        is_recurring: true,
        repeat_interval: "1week",
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.event_id).toBe("ce_5");
    expect(parsed.datetime).toBe("2026-05-05T10:00:00.000Z");
    expect(parsed.is_recurring).toBe(true);
    expect(parsed.repeat_interval).toBe("1week");
  });

  it("includes email_id in prompt JSON when context has emailId", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "email_notification", emailId: "em_abc123" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.email_id).toBe("em_abc123");
  });

  it("omits email_id when context has no emailId", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "email_notification" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.email_id).toBeUndefined();
  });

  it("omits email_id when context is undefined", () => {
    const task = makeTask("New email from a@b.com: Hi", "email_notification");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.email_id).toBeUndefined();
  });

  it("omits email_id when emailId is null in context", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "email_notification", emailId: null },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.email_id).toBeUndefined();
  });

  it("includes message_id in DM prompt when context has it", () => {
    const task: Task = {
      ...makeTask("Fix the bug"),
      context: { message_id: "msg_abc123" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.message_id).toBe("msg_abc123");
  });

  it("omits message_id for DM tasks without context", () => {
    const task = makeTask("Hello");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.message_id).toBeUndefined();
  });

  it("includes quoted_message in DM prompt when context has it", () => {
    const task: Task = {
      ...makeTask("Can you fix this?"),
      context: { quoted_message: { message_id: "msg_orig", excerpt: "The auth module has a bug" } },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.quoted_message).toEqual({ message_id: "msg_orig", excerpt: "The auth module has a bug" });
  });

  it("omits quoted_message for DM tasks without quote context", () => {
    const task = makeTask("Hello");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.quoted_message).toBeUndefined();
  });

  it("does not add notice for unknown task types", () => {
    const task = makeTask("Check inbox", "some_other_type");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toBeUndefined();
  });

  it("adds issue guidance for issue_event tasks", () => {
    const task = makeTask("Issue iss_1: Fix import", "issue_event");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("assigned issue");
    expect(parsed.notice).toContain("alook issue update");
    expect(parsed.notice).toContain("in_progress");
  });

  it("includes sender for DM tasks when sender is present", () => {
    const task: Task = {
      ...makeTask("Fix the login bug"),
      sender: { name: "Gus", email: "gus@ex.com", isOwner: true },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.sender).toEqual({ name: "Gus", email: "gus@ex.com", is_owner: true });
  });

  it("omits sender when sender is undefined", () => {
    const task = makeTask("Fix the bug");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.sender).toBeUndefined();
  });

  it("omits sender for email tasks (sender is not set)", () => {
    const task = makeTask("New email from a@b.com: Hi", "email_notification");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toBeDefined();
    expect(parsed.sender).toBeUndefined();
  });
});

describe("buildTaskObject", () => {
  it("returns the same object that buildPrompt would JSON.stringify", () => {
    const task = makeTask("Fix bug");
    const obj = buildTaskObject(task);
    expect(JSON.stringify(obj)).toBe(buildPrompt(task));
  });

  it("includes attachments when provided", () => {
    const task = makeTask("Fix bug");
    const att = [{ path: "/tmp/a.txt", content_type: "text/plain", filename: "a.txt" }];
    const obj = buildTaskObject(task, att);
    expect(obj.attachments).toEqual([{ path: "/tmp/a.txt", content_type: "text/plain", filename: "a.txt" }]);
  });
});

describe("buildMergedPrompt", () => {
  it("wraps multiple sub-tasks in a merge_tasks envelope sorted by received_at", () => {
    const taskA: Task = { ...makeTask("DM message", "user_dm_message"), id: "tA", createdAt: "2026-06-03T12:00:02.000Z" };
    const taskB: Task = {
      ...makeTask("New email from X: subject", "email_notification"),
      id: "tB",
      createdAt: "2026-06-03T12:00:01.000Z",
      context: { emailId: "em_abc" },
    };
    const taskC: Task = { ...makeTask("Another DM", "user_dm_message"), id: "tC", createdAt: "2026-06-03T12:00:03.000Z" };

    const attMap = new Map<string, any[]>();
    attMap.set("tA", [{ path: "/tmp/a.txt", content_type: "text/plain", filename: "a.txt" }]);

    const result = JSON.parse(buildMergedPrompt([taskA, taskB, taskC], attMap));

    expect(result.type).toBe("merge_tasks");
    expect(result.notice).toContain("simultaneously");
    expect(result.tasks).toHaveLength(3);
    // Sorted by received_at ascending (B=12:00:01, A=12:00:02, C=12:00:03).
    expect(result.tasks[0].instruction).toBe("New email from X: subject");
    expect(result.tasks[0].email_id).toBe("em_abc");
    expect(result.tasks[1].instruction).toBe("DM message");
    expect(result.tasks[1].attachments).toHaveLength(1);
    expect(result.tasks[2].instruction).toBe("Another DM");
  });

  it("produces valid JSON with self-contained sub-tasks", () => {
    const task = makeTask("Single task", "user_dm_message");
    const result = JSON.parse(buildMergedPrompt([task], new Map()));
    expect(result.type).toBe("merge_tasks");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].type).toBe("user_dm_message");
    expect(result.tasks[0].instruction).toBe("Single task");
  });
});
