type ReplyAuthor = { authorName: string } | null | undefined

function replyAuthorPrefix(replyTo: ReplyAuthor): string | null {
  if (!replyTo?.authorName) return null
  return `@${replyTo.authorName}`
}

function matchingReplyPrefixLength(content: string, replyTo: ReplyAuthor): number {
  const prefix = replyAuthorPrefix(replyTo)
  if (!prefix || !content.startsWith(prefix)) return 0
  const boundary = content.slice(prefix.length, prefix.length + 1)
  return boundary === "" || /\s/u.test(boundary) ? prefix.length : 0
}

/**
 * Canonical raw content for a reply. This runs once when a send/edit intent is
 * accepted; optimistic state, POST, and retry all reuse the returned string.
 */
export function canonicalizeReplyContent(content: string, replyTo: ReplyAuthor): string {
  const prefix = replyAuthorPrefix(replyTo)
  if (!prefix || matchingReplyPrefixLength(content, replyTo) > 0) return content
  return `${prefix}\n${content}`
}

/**
 * User-facing projection of canonical reply content. Only a prefix matching
 * the actual replied-to author is hidden. One following whitespace boundary
 * is removed as well; CRLF is treated as one line-break boundary.
 */
export function displayReplyContent(content: string, replyTo: ReplyAuthor): string {
  const prefixLength = matchingReplyPrefixLength(content, replyTo)
  if (prefixLength === 0) return content
  const remainder = content.slice(prefixLength)
  if (remainder.startsWith("\r\n")) return remainder.slice(2)
  return /^\s/u.test(remainder) ? remainder.slice(1) : remainder
}
