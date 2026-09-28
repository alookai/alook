import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { serverProjectedQueryFn, serverQueryFn } from "./use-servers"

const apiFetch = vi.fn()

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) }
})

function serverRow() {
  return {
    id: "server-1",
    position: 0,
    name: "Alook",
    discriminator: "0001",
    description: "Home",
    ownerId: "viewer",
    icon: null,
    official: true,
    isOwner: true,
    unread: false,
    mentions: 0,
    detailComplete: false,
  }
}

async function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  const unregister = registerCommunityDbRegistry(registry)
  await registry.ensureCollectionReady("servers")
  registry.collections.servers.utils.writeInsert(serverRow())
  return { queryClient, registry, unregister }
}

beforeEach(() => {
  vi.clearAllMocks()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/categories")) {
      return { categories: [{ id: "category-1", name: "General", private: false }] }
    }
    if (path.endsWith("/channels")) {
      return {
        channels: [{
          id: "channel-1",
          name: "chat",
          categoryId: "category-1",
          active: false,
          unread: true,
          type: "text",
        }],
      }
    }
    throw new Error(`unexpected ${path}`)
  })
})

describe("server detail over the official server collection", () => {
  it("resolves detail identity from the official collection", async () => {
    const runtime = await setup()

    await expect(serverQueryFn(runtime.queryClient, "server-1")()).resolves.toMatchObject({
      id: "server-1",
      name: "Alook",
      categories: [{ id: "category-1", channels: [{ id: "channel-1", unread: false }] }],
    })

    runtime.unregister()
    runtime.registry.cleanup()
    runtime.queryClient.clear()
  })

  it("keeps detail/category/channel publication on its existing path", async () => {
    const runtime = await setup()

    await serverProjectedQueryFn(runtime.queryClient, "server-1")()

    expect(runtime.registry.collections.servers.get("server-1")?.detailComplete).toBe(true)
    expect(runtime.registry.collections.channels.get("channel-1")).toMatchObject({
      serverId: "server-1",
      categoryId: "category-1",
    })

    runtime.unregister()
    runtime.registry.cleanup()
    runtime.queryClient.clear()
  })
})
