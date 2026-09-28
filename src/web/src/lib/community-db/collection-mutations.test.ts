import { describe, expect, it, vi } from "vitest"
import { writeCommunityCollectionRows } from "./collection-mutations"

type Row = { id: string; value: number; extra?: string }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

function fixture(
  persistenceQueue: Array<ReturnType<typeof deferred>> = [],
  durable = false,
) {
  const ready = deferred()
  let readinessPromise: Promise<void> | null = null
  let preloadFailure: Error | null = null
  const values = new Map<string, Row>()
  const operationConfigs: Array<{ optimistic?: boolean } | undefined> = []
  const collection = {
    status: "loading",
    preload: vi.fn(() => ready.promise.then(() => { collection.status = "ready" })),
    has: (key: string) => values.has(key),
    keys: () => values.keys(),
    insert: (rows: Row | Row[], config?: { optimistic?: boolean }) => {
      operationConfigs.push(config)
      for (const row of Array.isArray(rows) ? rows : [rows]) values.set(row.id, { ...row })
    },
    update: (
      key: string,
      config: { optimistic?: boolean },
      callback: (draft: Row) => void,
    ) => {
      operationConfigs.push(config)
      callback(values.get(key)!)
    },
    delete: (keys: string | string[], config?: { optimistic?: boolean }) => {
      operationConfigs.push(config)
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
    },
    utils: {
      acceptMutations: vi.fn(() => persistenceQueue.shift()?.promise),
      ...(durable ? { getLeadershipState: vi.fn() } : {}),
    },
  }
  const registry = {
    collections: { profiles: collection },
    ensureCollectionReady: () => {
      if (preloadFailure) return Promise.reject(preloadFailure)
      readinessPromise ??= collection.status === "ready"
        ? Promise.resolve()
        : collection.preload().catch((error: Error) => {
            preloadFailure = error
            throw error
          })
      return readinessPromise
    },
    isCollectionReady: () => collection.status === "ready" && !preloadFailure,
    assertGenerationActive: () => {
      if (preloadFailure) throw preloadFailure
    },
    dbClient: {
      createTransaction: ({ mutationFn }: {
        mutationFn: (args: { transaction: { mutations: [] } }) => Promise<void>
      }) => {
        let persisted = Promise.resolve()
        return {
          mutate: (publish: () => void) => {
            publish()
            persisted = mutationFn({ transaction: { mutations: [] } })
          },
          isPersisted: {
            get promise() {
              return persisted
            },
          },
        }
      },
    },
  }
  return { collection, operationConfigs, ready, registry, values }
}

describe("writeCommunityCollectionRows", () => {
  it("replays writes received during preload in arrival order", async () => {
    const { collection, ready, registry, values } = fixture()

    writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )
    writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 3 }],
      (row) => row.id,
    )

    expect(values.size).toBe(0)
    expect(collection.preload).toHaveBeenCalledOnce()
    ready.resolve()
    await vi.waitFor(() => expect(values.get("alice")?.value).toBe(3))
    expect(collection.utils.acceptMutations).toHaveBeenCalledTimes(2)
  })

  it("derives a queued snapshot from restored rows after preload", async () => {
    const { ready, registry, values } = fixture()

    const committed = writeCommunityCollectionRows(
      registry as never,
      "profiles",
      () => [
        ...values.values(),
        { id: "network", value: 2 },
      ],
      (row) => row.id,
    )

    values.set("restored", { id: "restored", value: 1 })
    ready.resolve()
    await committed

    expect([...values.values()]).toEqual([
      { id: "restored", value: 1 },
      { id: "network", value: 2 },
    ])
  })

  it("publishes immediately once ready and replaces stale rows and fields", async () => {
    const { collection, operationConfigs, ready, registry, values } = fixture()
    collection.status = "ready"
    ready.resolve()
    values.set("alice", { id: "alice", value: 1, extra: "stale" })
    values.set("bob", { id: "bob", value: 1 })

    writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )

    await vi.waitFor(() => {
      expect([...values.values()]).toEqual([{ id: "alice", value: 2 }])
    })
    expect(operationConfigs).toEqual([
      { optimistic: true },
      { optimistic: true },
    ])
  })

  it("keeps later snapshots behind the prior durable commit", async () => {
    const firstPersistence = deferred()
    const { collection, operationConfigs, registry, values } = fixture(
      [firstPersistence],
      true,
    )
    collection.status = "ready"

    writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )
    writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 3 }],
      (row) => row.id,
    )

    await vi.waitFor(() => expect(values.get("alice")?.value).toBe(2))
    expect(collection.utils.acceptMutations).toHaveBeenCalledOnce()
    expect(operationConfigs).toEqual([{ optimistic: false }])
    firstPersistence.resolve()
    await vi.waitFor(() => expect(values.get("alice")?.value).toBe(3))
    expect(collection.utils.acceptMutations).toHaveBeenCalledTimes(2)
  })

  it("fences a failed registry generation from later writes", async () => {
    const { collection, ready, registry, values } = fixture()
    writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 1 }],
      (row) => row.id,
    )
    ready.reject(new Error("preload failed"))
    await vi.waitFor(() => expect(collection.preload).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    collection.status = "ready"

    const rejected = writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )
    await expect(rejected).rejects.toThrow("preload failed")
    expect(values.size).toBe(0)
  })
})
