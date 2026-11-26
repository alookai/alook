export const UNAVAILABLE_MEMBER = "Member unavailable"

export function emailPrefix(email?: string | null): string {
  return email?.split("@")[0]?.trim() ?? ""
}

export function displayName(user?: {
  name?: string | null
  email?: string | null
} | null): string {
  const name = user?.name?.trim()
  if (name) return name
  const prefix = emailPrefix(user?.email)
  if (prefix) return prefix
  return UNAVAILABLE_MEMBER
}

export function makeUserNameResolver(
  list: ReadonlyArray<{
    userId?: string | null
    id?: string | null
    name?: string | null
    email?: string | null
  }>,
): (userId: string) => string {
  const namesById = new Map<string, string>()
  for (const row of list) {
    const key = row.userId ?? row.id
    if (key && !namesById.has(key)) namesById.set(key, displayName(row))
  }
  return (userId: string) => namesById.get(userId) ?? UNAVAILABLE_MEMBER
}
