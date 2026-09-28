import React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  useOptionalCommunityDbRegistry,
  useServerRailProjection,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
  type CommunityPublicationReceipt,
} from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/collection-mutations"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import type { ServersResponse } from "@/hooks/community/use-servers"

const controls = vi.hoisted(() => ({
  createCount: 0,
  mode: "ready" as "ready" | "delayed" | "swap",
  preloadGate: Promise.resolve(),
  registries: [] as Array<ReturnType<
    typeof import("@/lib/community-db/collections")["createCommunityDbRegistry"]
  >>,
}))

vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/browser-persistence", () => ({
  getBrowserPersistenceRuntime: vi.fn(async () => ({ persistence: null })),
  registerPersistenceClearScope: vi.fn(() => () => {}),
}))
vi.mock("@/lib/community-db/collections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community-db/collections")>()
  return {
    ...actual,
    createCommunityDbRegistry: (...args: Parameters<typeof actual.createCommunityDbRegistry>) => {
      const registry = actual.createCommunityDbRegistry(...args)
      controls.createCount += 1
      controls.registries.push(registry)
      if (controls.createCount === 1 && controls.mode !== "ready") {
        const preload = registry.collections.servers.preload.bind(registry.collections.servers)
        vi.spyOn(registry.collections.servers, "preload").mockImplementation(async () => {
          await controls.preloadGate
          if (controls.mode === "swap") throw new Error("first registry failed")
          await preload()
        })
      }
      return registry
    },
  }
})

import { QueryProvider } from "./QueryProvider"

const response: ServersResponse = {
  servers: [{
    id: "server-1",
    name: "Server",
    discriminator: "0001",
    description: "",
    ownerId: "viewer",
    initial: "S",
    active: false,
    unread: false,
    mentions: 0,
    isOwner: true,
    icon: null,
    official: false,
  }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function gateNextCollectionCommit(
  registry: CommunityDbRegistry,
  name: "servers" | "profiles",
  commit: Promise<void>,
) {
  const collection = registry.collections[name] as unknown as {
    utils: {
      acceptMutations: (transaction: unknown) => Promise<void> | void
      getLeadershipState?: () => unknown
    }
  }
  const acceptMutations = collection.utils.acceptMutations.bind(collection.utils)
  Object.assign(collection.utils, { getLeadershipState: vi.fn() })
  return vi.spyOn(collection.utils, "acceptMutations")
    .mockImplementationOnce(async (transaction) => {
      await commit
      await acceptMutations(transaction)
    })
}

async function mountReadyRegistry() {
  const renderer = render(
    <QueryProvider pending={<span>provider-pending</span>} userId="viewer">
      <span>provider-ready</span>
    </QueryProvider>,
  )
  await waitFor(() => expect(controls.registries).toHaveLength(1))
  const registry = controls.registries[0]!
  await registry.preload()
  return { registry, renderer }
}

function publishServers(registry: CommunityDbRegistry) {
  const token = captureCommunityLiveSnapshotToken(registry.queryClient)
  return publishCommunityLiveSnapshot(registry.queryClient, {
    snapshot: { kind: "servers", data: response },
    proof: { kind: "structural", token, signal: undefined },
  })
}

function startUnrelatedProfileWrite(
  registry: CommunityDbRegistry,
  commit: Promise<void>,
) {
  const acceptMutations = gateNextCollectionCommit(registry, "profiles", commit)
  const write = writeCommunityCollectionRows(
    registry,
    "profiles",
    [{
      userId: "peer",
      name: "Peer",
      discriminator: "0001",
      avatar: "P",
      avatarVersion: 1,
    }],
    (row) => row.userId,
  )
  return { acceptMutations, write }
}

function ServerProjection() {
  const registry = useOptionalCommunityDbRegistry()
  const projection = useServerRailProjection()
  const visible = projection?.servers.some((server) => server.id === "server-1") === true
  const committed = registry?.collections.servers.has("server-1") === true
  return (
    <span data-testid="route">
      {visible && committed ? "ready" : "pending"}
    </span>
  )
}

function PublicationOwner({
  attemptsRef,
  receipts,
  subscribeAfterReceipt,
  transport,
}: {
  attemptsRef: { current: number }
  receipts: CommunityPublicationReceipt[]
  subscribeAfterReceipt: boolean
  transport: Promise<ServersResponse>
}) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["community", "publication-generation-test", subscribeAfterReceipt],
    retry: false,
    queryFn: async ({ signal }) => {
      attemptsRef.current += 1
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const data = await transport
      const receipt = await publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "servers", data },
        proof: { kind: "structural", token, signal },
      })
      if (receipt !== "superseded") receipts.push(receipt)
      return data
    },
  })
  return (
    <div data-testid="query" data-status={query.status}>
      {!subscribeAfterReceipt || query.isSuccess ? <ServerProjection /> : <span>pending</span>}
    </div>
  )
}

function mountPublication(
  transport: Promise<ServersResponse>,
  subscribeAfterReceipt: boolean,
) {
  const attempts = { current: 0 }
  const receipts: CommunityPublicationReceipt[] = []
  const renderer = render(
    <QueryProvider pending={<span>provider-pending</span>} userId="viewer">
      <PublicationOwner
        attemptsRef={attempts}
        receipts={receipts}
        subscribeAfterReceipt={subscribeAfterReceipt}
        transport={transport}
      />
    </QueryProvider>,
  )
  return { attempts, receipts, renderer }
}

beforeEach(() => {
  controls.createCount = 0
  controls.mode = "ready"
  controls.preloadGate = Promise.resolve()
  controls.registries.length = 0
  useCommunityWsStore.getState().reset()
})

describe("QueryProvider generation-owned publication", () => {
  it("publishes before a route projection subscribes", async () => {
    const transport = deferred<ServersResponse>()
    const run = mountPublication(transport.promise, true)

    await waitFor(() => expect(controls.registries).toHaveLength(1))
    await controls.registries[0]!.preload()
    await act(async () => transport.resolve(response))

    await waitFor(() => expect(run.renderer.container).toHaveTextContent("ready"))
    expect(run.attempts.current).toBe(1)
    expect(run.receipts).toEqual([{ status: "published", generation: 1 }])
    expect(controls.registries[0]!.collections.servers.has("server-1")).toBe(true)
    run.renderer.unmount()
  })

  it("holds an early route subscription until canonical commit", async () => {
    let releasePreload!: () => void
    controls.mode = "delayed"
    controls.preloadGate = new Promise<void>((resolve) => { releasePreload = resolve })
    const transport = deferred<ServersResponse>()
    const run = mountPublication(transport.promise, false)

    await waitFor(() => expect(run.attempts.current).toBe(1))
    await act(async () => transport.resolve(response))
    expect(run.renderer.container).toHaveTextContent("pending")
    expect(run.renderer.container.querySelector("[data-testid='query']"))
      .toHaveAttribute("data-status", "pending")
    expect(run.receipts).toEqual([])

    await act(async () => releasePreload())
    await waitFor(() => expect(run.renderer.container).toHaveTextContent("ready"))
    expect(run.attempts.current).toBe(1)
    expect(run.receipts).toEqual([{ status: "published", generation: 1 }])
    expect(controls.registries[0]!.collections.servers.has("server-1")).toBe(true)
    run.renderer.unmount()
  })

  it("replays an in-flight settlement into the replacement registry", async () => {
    let failPreload!: () => void
    controls.mode = "swap"
    controls.preloadGate = new Promise<void>((resolve) => { failPreload = resolve })
    const transport = deferred<ServersResponse>()
    const run = mountPublication(transport.promise, false)

    await waitFor(() => expect(run.attempts.current).toBe(1))
    await act(async () => transport.resolve(response))
    expect(run.receipts).toEqual([])
    await act(async () => failPreload())

    await waitFor(() => expect(controls.registries).toHaveLength(2))
    await waitFor(() => expect(run.renderer.container).toHaveTextContent("ready"))
    expect(run.attempts.current).toBe(1)
    expect(run.receipts).toEqual([{ status: "published", generation: 2 }])
    expect(controls.registries[0]!.collections.servers.has("server-1")).toBe(false)
    expect(controls.registries[1]!.collections.servers.has("server-1")).toBe(true)
    run.renderer.unmount()
  })

  it("settles only after its own publication commit", async () => {
    const { registry, renderer } = await mountReadyRegistry()
    const ownCommit = deferred<void>()
    const acceptMutations = gateNextCollectionCommit(registry, "servers", ownCommit.promise)

    const receipt = publishServers(registry)
    await waitFor(() => expect(acceptMutations).toHaveBeenCalledOnce())
    await expect(Promise.race([
      receipt.then(() => "receipt"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ])).resolves.toBe("blocked")

    ownCommit.resolve(undefined)
    await expect(receipt).resolves.toEqual({ status: "published", generation: 1 })
    expect(registry.collections.servers.has("server-1")).toBe(true)
    renderer.unmount()
  })

  it("rejects its receipt when its own publication commit rejects", async () => {
    const { registry, renderer } = await mountReadyRegistry()
    const ownCommit = deferred<void>()
    const acceptMutations = gateNextCollectionCommit(registry, "servers", ownCommit.promise)

    const receipt = publishServers(registry)
    await waitFor(() => expect(acceptMutations).toHaveBeenCalledOnce())
    ownCommit.reject(new Error("own publication rejected"))

    await expect(receipt).rejects.toThrow("own publication rejected")
    renderer.unmount()
  })

  it("does not wait for an unrelated blocked collection commit", async () => {
    const { registry, renderer } = await mountReadyRegistry()
    const unrelatedCommit = deferred<void>()
    const unrelated = startUnrelatedProfileWrite(registry, unrelatedCommit.promise)
    await waitFor(() => expect(unrelated.acceptMutations).toHaveBeenCalledOnce())

    const receipt = publishServers(registry)
    await expect(Promise.race([
      receipt.then(() => "receipt"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("receipt")
    expect(registry.collections.servers.has("server-1")).toBe(true)

    unrelatedCommit.resolve(undefined)
    await unrelated.write
    renderer.unmount()
  })

  it("does not fail when an unrelated collection commit rejects", async () => {
    const { registry, renderer } = await mountReadyRegistry()
    const unrelatedCommit = deferred<void>()
    const unrelated = startUnrelatedProfileWrite(registry, unrelatedCommit.promise)
    await waitFor(() => expect(unrelated.acceptMutations).toHaveBeenCalledOnce())

    const receipt = publishServers(registry)
    await waitFor(() => expect(registry.collections.servers.has("server-1")).toBe(true))
    unrelatedCommit.reject(new Error("unrelated publication rejected"))

    await expect(unrelated.write).rejects.toThrow("unrelated publication rejected")
    await expect(receipt).resolves.toEqual({ status: "published", generation: 1 })
    renderer.unmount()
  })
})
