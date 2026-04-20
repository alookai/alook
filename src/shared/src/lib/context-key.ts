import { TASK_TYPES } from "../constants";

/**
 * Extract a stable thread identifier from email headers (RFC 2822).
 * Priority: first message-id in References > In-Reply-To > own Message-ID.
 */
export function extractThreadId(
  references?: string,
  inReplyTo?: string,
  messageId?: string,
): string | null {
  if (references) {
    const first = references.trim().split(/\s+/)[0];
    if (first) return first;
  }
  if (inReplyTo) return inReplyTo.trim();
  if (messageId) return messageId.trim();
  return null;
}

/**
 * Build a unified context key for session resumption.
 * Returns null when the task type should never resume (e.g. calendar events).
 */
export function buildContextKey(
  type: string,
  opts: { conversationId?: string; threadId?: string | null },
): string | null {
  switch (type) {
    case TASK_TYPES.USER_DM_MESSAGE:
      return opts.conversationId ? `dm:${opts.conversationId}` : null;
    case TASK_TYPES.EMAIL_NOTIFICATION:
      return opts.threadId ? `email:${opts.threadId}` : null;
    case TASK_TYPES.CALENDAR_EVENT:
      return null;
    default:
      return null;
  }
}
