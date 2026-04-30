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
 * Build the conversation_map lookup key for email threads.
 * Format: "email:<agentId>:<threadId>" — agent-scoped, thread-scoped.
 */
export function buildEmailMapKey(agentId: string, threadId: string): string {
  return `email:${agentId}:${threadId}`;
}
