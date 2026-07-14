const UNKNOWN_MEMBER = "Unknown member"

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
  return UNKNOWN_MEMBER
}

export function makeUserNameResolver(
  list: ReadonlyArray<{
    userId?: string | null
    id?: string | null
    name?: string | null
    email?: string | null
  }>,
): (userId: string) => string {
  return (userId: string) => {
    const row = list.find((r) => (r.userId ?? r.id) === userId)
    if (!row) return UNKNOWN_MEMBER
    return displayName(row)
  }
}
