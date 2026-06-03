import type { Task, Attachment } from "./types.js";
import { localISOString } from "./execenv/timeline.js";

const DM_RESPONSE_NOTICE =
  "Reply with `alook sync send-dm` — that's the only thing the user sees;" +
  " your task output and reasoning are not shown." +
  " Talk to them at milestones like a colleague would, and don't end your turn without sending what they need.";

const EMAIL_NOTICE =
  "This task was triggered automatically by an incoming email. There is no human in this session." +
  " If you need to communicate with a human, you MUST send an email using the email sending tool." +
  " If you need more information or confirmation from the human, send them an email asking for it and then exit." +
  " Do not wait — when the human replies, a new task will be triggered automatically and you will be woken up with their response.";

const CALENDAR_NOTICE =
  "This task was triggered by a scheduled calendar event. There is no human in this session." +
  " If you need to communicate with a human, you MUST send an email using the email sending tool." +
  " If you need more information or confirmation, send an email asking for it and then exit." +
  " Do not wait — when the human replies, a new task will be triggered automatically and you will be woken up with their response.";

const ISSUE_NOTICE =
  "This task was triggered by an assigned issue. The issue_id is provided in this message." +
  " Use `alook issue show --issue_id <issue_id>` to read full context." +
  " Use `alook issue update --issue_id <issue_id> --status <status>` to change status." +
  " Use `alook issue comment --issue_id <issue_id> --body <text>` to leave a comment." +
  " CRITICAL — You MUST manage the issue status correctly. This is NOT optional:" +
  " 1. Set status to 'in_progress' when you start working." +
  " 2. If you complete the work yourself: leave a summary comment, then set status to 'review' as your last action. 'review' means there is actual completed work (code, artifact, result) ready for the owner to look at." +
  " 3. If you delegated work to colleagues and are waiting for their response: KEEP status as 'in_progress' and exit. This is expected — you will be woken up when they reply. Set 'review' only after all delegated work is confirmed complete." +
  " 4. NEVER set 'review' unless there is concrete completed work for the owner to review. Sending a plan to a colleague is NOT completed work." +
  " NEVER exit without doing at least one of: updating the status, or leaving a comment explaining what you did and what you're waiting for.";

function buildDmNotice(name: string, email: string): string {
  return (
    `This task was triggered by an incoming email on a conversation with ${name} (${email}).` +
    ` ${name} is present in this session — reply to them directly.` +
    ` If you need to communicate with anyone else, use the email sending tool.`
  );
}

export function buildTaskObject(task: Task, attachments?: Attachment[]): Record<string, unknown> {
  const createdAt = new Date(task.createdAt);
  const receivedAt = Number.isNaN(createdAt.getTime())
    ? localISOString()
    : localISOString(createdAt);
  const obj: Record<string, unknown> = {
    type: task.type,
    received_at: receivedAt,
    instruction: task.prompt,
  };
  if (task.type === "user_dm_message") {
    obj.notice = DM_RESPONSE_NOTICE;
  }
  if (task.type === "email_notification") {
    const ctx = task.context as Record<string, unknown> | undefined;
    const dmUser = ctx?.dmUser as { name: string; email: string } | undefined;
    if (ctx?.conversationType === "user_dm_message" && dmUser) {
      obj.notice = buildDmNotice(dmUser.name, dmUser.email);
    } else {
      obj.notice = EMAIL_NOTICE;
    }
    if (ctx?.emailId != null) {
      obj.email_id = ctx.emailId;
    }
  }
  if (task.type === "calendar_event") {
    obj.notice = CALENDAR_NOTICE;
    const ctx = task.context as Record<string, unknown> | undefined;
    if (ctx?.event_id != null) {
      obj.event_id = ctx.event_id;
    }
    if (ctx?.datetime != null) {
      obj.datetime = ctx.datetime;
    }
    if (ctx?.is_recurring !== undefined) {
      obj.is_recurring = ctx.is_recurring;
    }
    if (ctx?.repeat_interval !== undefined) {
      obj.repeat_interval = ctx.repeat_interval;
    }
    if (ctx?.description) {
      obj.description = ctx.description;
    }
    if (ctx?.scheduled_by) {
      obj.scheduled_by = ctx.scheduled_by;
    }
  }
  if (task.type === "issue_event") {
    obj.notice = ISSUE_NOTICE;
    const ctx = task.context as Record<string, unknown> | undefined;
    if (ctx?.issue_id) {
      obj.issue_id = ctx.issue_id;
    }
  }
  if (task.sender) {
    obj.sender = {
      name: task.sender.name,
      email: task.sender.email,
      is_owner: task.sender.isOwner,
    };
  }
  if (attachments && attachments.length > 0) {
    obj.attachments = attachments.map((a) => ({
      path: a.path,
      content_type: a.content_type,
      filename: a.filename,
    }));
  }
  return obj;
}

export function buildPrompt(task: Task, attachments?: Attachment[]): string {
  return JSON.stringify(buildTaskObject(task, attachments));
}

export function buildMergedPrompt(tasks: Task[], attachmentsMap: Map<string, Attachment[]>): string {
  const subTasks = tasks
    .map((t) => buildTaskObject(t, attachmentsMap.get(t.id)))
    .sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  return JSON.stringify({
    type: "merge_tasks",
    notice: "These messages arrived simultaneously. Process each one completely.",
    tasks: subTasks,
  });
}
