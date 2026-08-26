export type MemberSearchCursor = {
  serverId: string
  query: string
  name: string
  id: string
}

export function encodeMemberSearchCursor(cursor: MemberSearchCursor): string {
  const ascii = encodeURIComponent(JSON.stringify(cursor))
  return btoa(ascii).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export function parseMemberSearchCursor(
  raw: string | null,
  scope: { serverId: string; query: string },
): { name: string; id: string } | null | undefined {
  if (!raw) return undefined
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const value = JSON.parse(decodeURIComponent(atob(padded))) as Partial<MemberSearchCursor>
    if (
      value.serverId !== scope.serverId
      || value.query !== scope.query
      || typeof value.name !== "string"
      || typeof value.id !== "string"
      || value.id.length === 0
    ) return null
    return { name: value.name, id: value.id }
  } catch {
    return null
  }
}
