import type { QueryClient } from "@tanstack/react-query"

export type MessageAccessScope = {
  channelId?: string
  serverId?: string | null
}

const messageAccessScopes = new WeakMap<QueryClient, Map<string, MessageAccessScope>>()

export function rememberMessageAccessScope(
  queryClient: QueryClient,
  messageId: string,
  scope: MessageAccessScope,
) {
  let scopes = messageAccessScopes.get(queryClient)
  if (!scopes) {
    scopes = new Map()
    messageAccessScopes.set(queryClient, scopes)
  }
  scopes.set(messageId, scope)
}

export function takeMessageIdsForAccessScope(
  queryClient: QueryClient,
  channelIds: ReadonlySet<string>,
  serverId: string | null,
) {
  const scopes = messageAccessScopes.get(queryClient)
  if (!scopes) return []
  const messageIds: string[] = []
  for (const [messageId, scope] of scopes) {
    if (
      (scope.channelId !== undefined && channelIds.has(scope.channelId))
      || (serverId !== null && scope.serverId === serverId)
    ) {
      messageIds.push(messageId)
      scopes.delete(messageId)
    }
  }
  return messageIds
}
