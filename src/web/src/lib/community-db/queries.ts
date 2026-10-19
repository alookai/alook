import { eq, inArray, type WhereCallback, type ContextFromSource } from "@tanstack/react-db"
import type { CommunityDbRegistry } from "./collections"
import type { CommunityCollectionName } from "./schema"

type CollectionWhere<N extends CommunityCollectionName> = WhereCallback<ContextFromSource<{ row: CommunityDbRegistry["collections"][N] }>>

export function communityCollectionQuery<N extends CommunityCollectionName>(registry: CommunityDbRegistry | null, name: N, where?: CollectionWhere<N>, enabled = true) {
  return { query: (q: import("@tanstack/react-db").InitialQueryBuilder) => {
    if (!registry || !enabled) return undefined
    const query = q.from({ row: registry.collections[name] })
    return where ? query.where(where) : query
  } }
}

export function communityJoinedMessagesQuery(registry: CommunityDbRegistry | null, channelId: string | null | undefined, ids?: readonly string[]) {
  return { query: (q: import("@tanstack/react-db").InitialQueryBuilder) => registry && (channelId === undefined || !!channelId)
    ? q.from({ message: registry.collections.messages }).where(({ message }) => channelId === undefined ? eq(1, 1) : eq(message.channelId, channelId))
      .where(({ message }) => ids === undefined ? eq(1, 1) : inArray(message.id, [...ids]))
      .leftJoin({ child: registry.collections.channels }, ({ message, child }) => eq(message.id, child.parentMessageId))
      .select(({ message, child }) => ({ message, child }))
    : undefined }
}
