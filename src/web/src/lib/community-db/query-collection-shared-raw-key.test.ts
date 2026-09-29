import { QueryClient } from "@tanstack/react-query"
import { DbClient, collectionOptions } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { describe, expect, it, vi } from "vitest"

type Server = { id: string; name: string }
type Channel = { id: string; name: string }
type Envelope = { servers: Server[]; channels: Channel[] }

function descriptor<T extends Server | Channel>(
  id: string,
  dbClient: DbClient,
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<Envelope>,
  select: (envelope: Envelope) => T[],
) {
  const options = queryCollectionOptions({
    id,
    queryClient,
    queryKey,
    queryFn,
    select,
    getKey: (row) => row.id,
    staleTime: Infinity,
  })
  return dbClient.collection(collectionOptions(id, () => options))
}

describe("query collection 1.2.15 shared raw-key compatibility", () => {
  it("shares transport while keeping descriptor publication and direct writes isolated", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const serverDb = new DbClient({ queryClient })
    const channelDb = new DbClient({ queryClient })
    const rawKey = ["community", "resource", "server-a"] as const
    const envelope: Envelope = {
      servers: [{ id: "server-a", name: "Server A" }],
      channels: [{ id: "channel-a", name: "General" }],
    }
    const queryFn = vi.fn(async () => envelope)
    const servers = descriptor(
      "shared-key-servers",
      serverDb,
      queryClient,
      rawKey,
      queryFn,
      (value) => value.servers,
    )
    const channels = descriptor(
      "shared-key-channels",
      channelDb,
      queryClient,
      rawKey,
      queryFn,
      (value) => value.channels,
    )

    await Promise.all([servers.preload(), channels.preload()])
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(servers.get("server-a")).toMatchObject({ id: "server-a", name: "Server A" })
    expect(channels.get("channel-a")).toMatchObject({ id: "channel-a", name: "General" })

    servers.utils.writeUpdate({ id: "server-a", name: "Renamed server" })
    expect(queryClient.getQueryData<Envelope>(rawKey)).toEqual({
      servers: [{ id: "server-a", name: "Renamed server" }],
      channels: [{ id: "channel-a", name: "General" }],
    })
    expect(channels.get("channel-a")?.name).toBe("General")

    channels.utils.writeUpdate({ id: "channel-a", name: "Renamed channel" })
    expect(queryClient.getQueryData<Envelope>(rawKey)).toEqual({
      servers: [{ id: "server-a", name: "Renamed server" }],
      channels: [{ id: "channel-a", name: "Renamed channel" }],
    })
    expect(servers.get("server-a")?.name).toBe("Renamed server")

    await Promise.all([serverDb.cleanup(), channelDb.cleanup()])
    queryClient.clear()
  })

  it("does not let one descriptor cleanup revoke or block the sibling refetch/restore", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const serverDb = new DbClient({ queryClient })
    const channelDb = new DbClient({ queryClient })
    const rawKey = ["community", "resource", "server-b"] as const
    let envelope: Envelope = {
      servers: [{ id: "server-b", name: "Server B" }],
      channels: [{ id: "channel-b", name: "Before" }],
    }
    const queryFn = vi.fn(async () => envelope)
    const servers = descriptor(
      "shared-cleanup-servers",
      serverDb,
      queryClient,
      rawKey,
      queryFn,
      (value) => value.servers,
    )
    const channels = descriptor(
      "shared-cleanup-channels",
      channelDb,
      queryClient,
      rawKey,
      queryFn,
      (value) => value.channels,
    )
    await Promise.all([servers.preload(), channels.preload()])

    await serverDb.cleanup()
    expect(channels.get("channel-b")?.name).toBe("Before")
    envelope = {
      servers: [{ id: "server-b", name: "Server B2" }],
      channels: [{ id: "channel-b", name: "After" }],
    }
    await channels.utils.refetch({ throwOnError: true })
    expect(channels.get("channel-b")?.name).toBe("After")

    const restoredServerDb = new DbClient({ queryClient })
    const restoredServers = descriptor(
      "shared-cleanup-servers-restored",
      restoredServerDb,
      queryClient,
      rawKey,
      queryFn,
      (value) => value.servers,
    )
    await restoredServers.preload()
    expect(restoredServers.get("server-b")?.name).toBe("Server B2")
    expect(channels.get("channel-b")?.name).toBe("After")

    await Promise.all([channelDb.cleanup(), restoredServerDb.cleanup()])
    queryClient.clear()
  })
})
