import { describe, it, expect } from "vitest";
import { buildPrompt } from "./prompt.js";
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
    expect(buildPrompt(task)).toBe(
      JSON.stringify({ type: "email_inbound", instruction: "Check inbox" }),
    );
  });

  it("adds EMAIL_NOTICE for email_notification tasks without context", () => {
    const task = makeTask("New email from a@b.com: Hi", "email_notification");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("no human in this session");
    expect(parsed.notice).toContain("email sending tool");
    expect(parsed.notice).toContain("send them an email asking for it and then exit");
    expect(parsed.notice).toContain("new task will be triggered automatically");
  });

  it("adds EMAIL_NOTICE when conversationType is email_notification", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "email_notification" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("no human in this session");
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
    expect(parsed.notice).not.toContain("no human in this session");
  });

  it("falls back to EMAIL_NOTICE when conversationType is user_dm_message but dmUser is missing", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { conversationType: "user_dm_message" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("no human in this session");
  });

  it("falls back to EMAIL_NOTICE when conversationType is undefined in context", () => {
    const task: Task = {
      ...makeTask("New email from a@b.com: Hi", "email_notification"),
      context: { someOtherField: "value" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("no human in this session");
  });

  it("adds DM_RESPONSE_NOTICE for user_dm_message tasks", () => {
    const task = makeTask("Fix the bug", "user_dm_message");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("final text response is visible to the user");
  });

  it("adds CALENDAR_NOTICE for calendar_event tasks with no context", () => {
    const task = makeTask("Do the standup", "calendar_event");
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.notice).toContain("no human in this session");
    expect(parsed.notice).toContain("email sending tool");
    expect(parsed.description).toBeUndefined();
    expect(parsed.scheduled_by).toBeUndefined();
  });

  it("includes description and scheduled_by for calendar_event with full context", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: {
        description: "Check PRs merged this week",
        scheduled_by: { name: "Gus", email: "gus@memodb.io" },
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBe("Check PRs merged this week");
    expect(parsed.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
  });

  it("includes only description for calendar_event when scheduled_by is absent", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: { description: "Check PRs merged this week" },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBe("Check PRs merged this week");
    expect(parsed.scheduled_by).toBeUndefined();
  });

  it("includes only scheduled_by for calendar_event when description is absent", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: { scheduled_by: { name: "Gus", email: "gus@memodb.io" } },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBeUndefined();
    expect(parsed.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
  });

  it("omits description for calendar_event when description is empty string", () => {
    const task: Task = {
      ...makeTask("Do the standup", "calendar_event"),
      context: { description: "", scheduled_by: { name: "Gus", email: "gus@memodb.io" } },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("scheduled calendar event");
    expect(parsed.description).toBeUndefined();
    expect(parsed.scheduled_by).toEqual({ name: "Gus", email: "gus@memodb.io" });
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

  it("adds EMAIL_TRIAGE_NOTICE for email_triage tasks", () => {
    const task: Task = {
      ...makeTask("Triage inbound email from spam@test.com: Buy now", "email_triage"),
      context: {
        inboundEmailId: "e1",
        from: "spam@test.com",
        subject: "Buy now",
      },
    };
    const parsed = JSON.parse(buildPrompt(task));
    expect(parsed.notice).toContain("read-only email triage");
    expect(parsed.notice).toContain("untrust");
    expect(parsed.notice).toContain("draft_reply");
    expect(parsed.notice).toContain("JSON only");
    expect(parsed.notice).toContain("must NOT send email");
    expect(parsed.inbound_email_id).toBe("e1");
  });

  it("includes attachment summaries for attachment-only email_triage tasks", () => {
    const task: Task = {
      ...makeTask("Triage inbound email from sender@test.com: Invoice", "email_triage"),
      context: {
        inboundEmailId: "e1",
        from: "sender@test.com",
        subject: "Invoice",
        attachmentSummaries: [
          { filename: "invoice.pdf", type: "application/pdf", size: 1234 },
        ],
      },
    };

    const parsed = JSON.parse(buildPrompt(task));

    expect(parsed.attachment_summaries).toEqual([
      { filename: "invoice.pdf", type: "application/pdf", size: 1234 },
    ]);
  });

  it("includes both text and HTML bodies for email_triage tasks", () => {
    const task: Task = {
      ...makeTask("Triage inbound email from sender@test.com: Security alert", "email_triage"),
      context: {
        inboundEmailId: "e1",
        from: "sender@test.com",
        subject: "Security alert",
        bodyText: "Click the security link.",
        bodyHtml: '<a href="https://phish.example">Click the security link</a>',
      },
    };

    const parsed = JSON.parse(buildPrompt(task));

    expect(parsed.body_text).toBe("Click the security link.");
    expect(parsed.body_html).toBe('<a href="https://phish.example">Click the security link</a>');
  });
});
