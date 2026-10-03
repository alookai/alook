"use client"

import { createStoreContext } from "@tanstack/react-store"
import type { Store } from "@tanstack/store"
import type { QueryClient } from "@tanstack/react-query"
import type { createCommunityStore } from "./ui-store"
import type { createCommunityWsStore } from "./ws-store"
import type { createMessageStreamStore } from "./message-stream-store"
import type { createOwnerServerDeleteStore } from "@/lib/community/eject-server"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"

export type CommunityRuntime = {
  ui: ReturnType<typeof createCommunityStore>
  ws: ReturnType<typeof createCommunityWsStore>
  messageStream: ReturnType<typeof createMessageStreamStore>
  serverEject: ReturnType<typeof createOwnerServerDeleteStore>
  lifecycle: Store<{ active: boolean; generation: number }>
  transport: { send: ((message: object) => void) | null }
}
const { StoreProvider, useStoreContext } = createStoreContext<{ runtime: CommunityRuntime }>()
export const CommunityRuntimeProvider = StoreProvider
export const useCommunityRuntime = () => useStoreContext().runtime
export function getCommunityRuntime(queryClient: QueryClient): CommunityRuntime {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) throw new DOMException("Missing or retired community owner", "AbortError")
  return registry.runtime
}

export function readCurrentCommunityChannelMeta(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) throw new DOMException("Missing community channel owner", "AbortError")
  const id = registry.runtime.ui.get().currentChannelId
  return id ? registry.collections.channels.get(id) ?? null : null
}
