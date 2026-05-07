import type { Task, Attachment } from "./types.js";

const DM_RESPONSE_NOTICE =
  "IMPORTANT: Only your final text response is visible to the user." +
  " Tool calls, intermediate reasoning, and mid-process outputs are NOT displayed." +
  " Put all key information, answers, and conclusions in your final response — that is the only thing the user will read.";

const EMAIL_NOTICE =
  "This task was triggered automatically by an incoming email. There is no human in this session." +
  " If you need to communicate with a human, you MUST send an email using the email sending tool." +
  " If you need more information or confirmation from the human, send them an email asking for it and then exit." +
  " Do not wait — when the human replies, a new task will be triggered automatically and you will be woken up with their response.";

const ISSUE_NOTICE =
  "This task was triggered by an assigned issue. The issue_id is provided in this message." +
  " Use `alook issue show --agent_id <your_agent_id> --issue_id <issue_id>` to read full context." +
  " Use `alook issue update --agent_id <your_agent_id> --issue_id <issue_id> --status <status>` to change status." +
  " Use `alook issue comment --agent_id <your_agent_id> --issue_id <issue_id> --body <text>` to leave a comment." +
  " You are responsible for setting the issue status: move to in_progress when working, review when awaiting user feedback, done/closed when finished." +
  " Always leave a comment summarizing what you did before changing status.";

function buildDmNotice(name: string, email: string): string {
  return (
    `This task was triggered by an incoming email on a conversation with ${name} (${email}).` +
    ` ${name} is present in this session — reply to them directly.` +
    ` If you need to communicate with anyone else, use the email sending tool.`
  );
}

export function buildPrompt(task: Task, attachments?: Attachment[]): string {
  const obj: Record<string, unknown> = { type: task.type, instruction: task.prompt };
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
  return JSON.stringify(obj);
}
