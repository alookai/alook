export const MENTION_TOKEN_RE = /@\[([^\]]+)\]\(([A-Za-z0-9_-]+)\)/g

export function stripMentionTokens(text: string): string {
  if (!text) return text
  return text.replace(MENTION_TOKEN_RE, (_m, label) => `@${label}`)
}
