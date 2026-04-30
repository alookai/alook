import type { Task, Attachment } from "./types.js";

const EMAIL_NOTICE =
  "This task was triggered automatically by an incoming email. There is no human in this session." +
  " If you need to communicate with a human, you MUST send an email using the email sending tool." +
  " If you need more information or confirmation from the human, send them an email asking for it and then exit." +
  " Do not wait — when the human replies, a new task will be triggered automatically and you will be woken up with their response.";

function buildDmNotice(name: string, email: string): string {
  return (
    `This task was triggered by an incoming email on a conversation with ${name} (${email}).` +
    ` ${name} is present in this session — reply to them directly.` +
    ` If you need to communicate with anyone else, use the email sending tool.`
  );
}

export function buildPrompt(task: Task, attachments?: Attachment[]): string {
  const obj: Record<string, unknown> = { type: task.type, instruction: task.prompt };
  if (task.type === "email_notification") {
    const ctx = task.context as Record<string, unknown> | undefined;
    const dmUser = ctx?.dmUser as { name: string; email: string } | undefined;
    if (ctx?.conversationType === "user_dm_message" && dmUser) {
      obj.notice = buildDmNotice(dmUser.name, dmUser.email);
    } else {
      obj.notice = EMAIL_NOTICE;
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
