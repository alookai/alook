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

const EMAIL_TRIAGE_NOTICE =
  "This is a read-only email triage task. You must NOT send email, modify files, change whitelist/calendar, or perform any write action." +
  " Classify obvious spam, phishing, scam, cold outreach, promotion, or newsletter as untrust." +
  " If the email looks worth replying to, draft a reply for human review." +
  " Respond with JSON only, using exactly one of these shapes:" +
  ' {"decision":"untrust"} or {"decision":"draft_reply","draft":{"subject":"...","htmlBody":"..."}}.' +
  " Do not include markdown fences or extra commentary outside the JSON.";

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
  if (task.type === "email_triage") {
    obj.notice = EMAIL_TRIAGE_NOTICE;
    const ctx = task.context as Record<string, unknown> | undefined;
    if (ctx?.from) obj.from = ctx.from;
    if (ctx?.to) obj.to = ctx.to;
    if (ctx?.subject) obj.subject = ctx.subject;
    if (ctx?.messageId) obj.message_id = ctx.messageId;
    if (ctx?.inReplyTo) obj.in_reply_to = ctx.inReplyTo;
    if (ctx?.references) obj.references = ctx.references;
    if (ctx?.bodyText) obj.body_text = ctx.bodyText;
    if (ctx?.bodyHtml) obj.body_html = ctx.bodyHtml;
    if (ctx?.attachments) obj.attachments = ctx.attachments;
    if (ctx?.attachmentSummaries) obj.attachment_summaries = ctx.attachmentSummaries;
    if (ctx?.inboundEmailId) obj.inbound_email_id = ctx.inboundEmailId;
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
