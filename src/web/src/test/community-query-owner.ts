import { beforeEach } from "vitest"
import { act } from "react"
import { QueryClient, type InfiniteData, type QueryKey, type SetDataOptions, type QueryClientConfig } from "@tanstack/react-query"
import { createCommunityDbRegistry, getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestMessages } from "@/lib/community-db/sync"
import type { MessagesPage } from "@/hooks/community/use-messages"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { communityKeys } from "@/lib/query-keys"
import type { ReadStateRow } from "@/lib/community-db/schema"
import { EMPTY_STORED, messageScopeKey } from "@/stores/community/message-stream-store"
import type { MessageScope } from "@/lib/community/message-stream"

const owners = new Set<CommunityDbRegistry>()
export function getMessageStreamState(client: QueryClient, scope: MessageScope) {
  return getCommunityRuntime(client).messageStream.get().entries.get(messageScopeKey(scope))?.state ?? EMPTY_STORED
}
export function canonicalMessageReader(client: QueryClient) {
  return { get: (id: string) => {
    const row = getCommunityDbRegistry(client)?.collections.messages.get(id)
    return row && typeof row.seq === "number" ? { ...row, seq: row.seq } : undefined
  } }
}
export async function createCommunityQueryOwner(accountId = "viewer", config?: QueryClientConfig) {
  const client = new QueryClient(config ?? { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const registry = createCommunityDbRegistry(client, accountId)
  owners.add(registry)
  await registry.preload()
  return { client, registry, runtime: registry.runtime }
}
export function seedCommunityMessageWindow(client: QueryClient, key: QueryKey, window: InfiniteData<MessagesPage>, options?: SetDataOptions) {
  const registry = getCommunityDbRegistry(client)
  if (!registry || key.at(-1) !== "messages") throw new Error("Message fixture requires its original owner and window key")
  ingestMessages(registry, String(key.at(-2)), window.pages.flatMap((page) => page.messages))
  return client.setQueryData(key, {
    ...window,
    pages: window.pages.map((page) => ({ ...page, hasMoreNewer: page.hasMoreNewer ?? false, messages: page.messages.map(({ id }) => ({ id })) })),
  }, options)
}
export function seedCommunityReadState(client: QueryClient, channelId: string, row: { lastReadMessageId?: string | null; lastReadAt?: string | null; lastReadSeq: number }) {
  const registry = getCommunityDbRegistry(client)
  if (!registry) throw new Error("Read-state fixture requires its original owner")
  client.setQueryData<ReadStateRow[]>(communityKeys.communityDbCollection(registry.scopeId, "readStates"), (rows) => [
    ...(rows ?? []).filter((current) => current.channelId !== channelId),
    { channelId, lastReadMessageId: null, lastReadAt: null, ...row },
  ])
}
beforeEach(() => async () => {
  const retire = async () => {
    for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
    owners.clear()
  }
  if (typeof document === "undefined") await retire()
  else await act(retire)
})
