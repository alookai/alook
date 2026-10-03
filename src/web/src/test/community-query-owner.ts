import { beforeEach } from "vitest"
import { act } from "react"
import { QueryClient, type InfiniteData, type QueryKey, type SetDataOptions, type QueryClientConfig } from "@tanstack/react-query"
import { createCommunityDbRegistry, getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestMessages } from "@/lib/community-db/sync"
import type { MessagesPage } from "@/hooks/community/use-messages"

const owners = new Set<CommunityDbRegistry>()
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
    pages: window.pages.map((page) => ({ ...page, messages: page.messages.map(({ id }) => ({ id })) })),
  }, options)
}
beforeEach(() => async () => {
  const retire = async () => {
    for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
    owners.clear()
  }
  if (typeof document === "undefined") await retire()
  else await act(retire)
})
