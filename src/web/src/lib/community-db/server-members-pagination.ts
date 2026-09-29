export function serverMembersRowsKey(accountId: string, serverId: string) {
  return ["community", "db", accountId, "server-members-resource", "rows", serverId] as const
}

export function serverMembersPagesKey(accountId: string, serverId: string) {
  return ["community", "db", accountId, "server-members-resource", "pages", serverId] as const
}

export function serverIdFromServerMembersResourceKey(queryKey: readonly unknown[]) {
  if (
    queryKey[0] !== "community"
    || queryKey[1] !== "db"
    || typeof queryKey[2] !== "string"
    || queryKey[3] !== "server-members-resource"
    || (queryKey[4] !== "rows" && queryKey[4] !== "pages")
    || typeof queryKey[5] !== "string"
  ) return null
  return queryKey[5]
}
