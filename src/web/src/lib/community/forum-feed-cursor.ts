export type ForumCreatedAtCursor = {
  parentChannelId: string
  createdAt: string
  id: string
  tag: string | null
}

export function encodeForumCreatedAtCursor(cursor: ForumCreatedAtCursor): string {
  const ascii = encodeURIComponent(JSON.stringify(cursor))
  return btoa(ascii).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export function parseForumCreatedAtCursor(
  raw: string | null,
  scope: { parentChannelId: string; tag: string | null },
): { createdAt: string; id: string } | null | undefined {
  if (!raw) return undefined
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const value = JSON.parse(decodeURIComponent(atob(padded))) as Partial<ForumCreatedAtCursor>
    if (
      value.parentChannelId !== scope.parentChannelId
      || value.tag !== scope.tag
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt
      || typeof value.id !== "string"
      || value.id.length === 0
    ) return null
    return { createdAt: value.createdAt, id: value.id }
  } catch {
    return null
  }
}
