export type ForumActivityCursor = {
  parentChannelId: string
  activityAt: string
  id: string
  tag: string | null
}

export function encodeForumActivityCursor(cursor: ForumActivityCursor): string {
  const ascii = encodeURIComponent(JSON.stringify(cursor))
  return btoa(ascii).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export function parseForumActivityCursor(
  raw: string | null,
  scope: { parentChannelId: string; tag: string | null },
): { activityAt: string; id: string } | null | undefined {
  if (!raw) return undefined
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const value = JSON.parse(decodeURIComponent(atob(padded))) as Partial<ForumActivityCursor>
    if (
      value.parentChannelId !== scope.parentChannelId
      || value.tag !== scope.tag
      || typeof value.activityAt !== "string"
      || !Number.isFinite(Date.parse(value.activityAt))
      || new Date(value.activityAt).toISOString() !== value.activityAt
      || typeof value.id !== "string"
      || value.id.length === 0
    ) return null
    return { activityAt: value.activityAt, id: value.id }
  } catch {
    return null
  }
}
