import { describe, expect, it, vi } from "vitest"
import { writeCommunityCollectionRows } from "./collection-mutations"

type Row = { id: string; value: number; extra?: string }

function queryCollectionFixture() {
  const values = new Map<string, Row>()
  let ready = false
  let readyListener: (() => void) | undefined
  let generationFailure: Error | null = null
  const collection = {
    keys: () => values.keys(),
    isReady: () => ready,
    onFirstReady: vi.fn((listener: () => void) => {
      readyListener = listener
      return () => {
        if (readyListener === listener) readyListener = undefined
      }
    }),
    startSyncImmediate: vi.fn(),
    utils: {
      writeBatch: vi.fn((publish: () => void) => {
        if (!ready) {
          const error = new Error("manual sync is not initialized")
          error.name = "SyncNotInitializedError"
          throw error
        }
        publish()
      }),
      writeDelete: vi.fn((keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
      }),
      writeUpsert: vi.fn((rows: Row | Row[]) => {
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          values.set(row.id, { ...row })
        }
      }),
    },
  }
  const registry = {
    collections: { profiles: collection },
    assertGenerationActive: vi.fn(() => {
      if (generationFailure) throw generationFailure
    }),
  }
  return {
    collection,
    failGeneration: (error: Error) => { generationFailure = error },
    markReady: () => {
      ready = true
      readyListener?.()
    },
    registry,
    values,
  }
}

describe("writeCommunityCollectionRows", () => {
  it("rethrows write failures that are not cold manual-sync initialization", async () => {
    const failure = new Error("write failed")
    const collection = {
      keys: () => new Map().keys(),
      startSyncImmediate: vi.fn(),
      onFirstReady: vi.fn(),
      isReady: () => false,
      utils: {
        writeBatch: () => { throw failure },
        writeDelete: vi.fn(),
        writeUpsert: vi.fn(),
      },
    }
    const registry = {
      collections: { profiles: collection },
      assertGenerationActive: vi.fn(),
    }

    await expect(writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 1 }],
      (row) => row.id,
    )).rejects.toBe(failure)
  })

  it("retries a cold manual-sync write immediately when readiness is already true", async () => {
    const values = new Map<string, Row>()
    let attempt = 0
    const collection = {
      keys: () => values.keys(),
      startSyncImmediate: vi.fn(),
      onFirstReady: vi.fn(),
      isReady: () => true,
      utils: {
        writeBatch: vi.fn((publish: () => void) => {
          if (attempt++ === 0) {
            const error = new Error("manual sync is not initialized")
            error.name = "SyncNotInitializedError"
            throw error
          }
          publish()
        }),
        writeDelete: vi.fn(),
        writeUpsert: vi.fn((rows: Row | Row[]) => {
          for (const row of Array.isArray(rows) ? rows : [rows]) values.set(row.id, row)
        }),
      },
    }
    const registry = {
      collections: { profiles: collection },
      assertGenerationActive: vi.fn(),
    }

    await writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 1 }],
      (row) => row.id,
    )

    expect(values.get("alice")).toEqual({ id: "alice", value: 1 })
    expect(collection.onFirstReady).not.toHaveBeenCalled()
    expect(collection.utils.writeBatch).toHaveBeenCalledTimes(2)
  })

  it("starts an on-demand QueryCollection before its first canonical write", async () => {
    const { collection, markReady, registry, values } = queryCollectionFixture()
    const write = writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 1 }],
      (row) => row.id,
    )

    expect(collection.startSyncImmediate).toHaveBeenCalledOnce()
    expect(values.size).toBe(0)
    markReady()
    await write

    expect(values.get("alice")).toEqual({ id: "alice", value: 1 })
  })

  it("replays writes received during initialization in arrival order", async () => {
    const { collection, markReady, registry, values } = queryCollectionFixture()
    const first = writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )
    const second = writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 3 }],
      (row) => row.id,
    )

    expect(values.size).toBe(0)
    expect(collection.onFirstReady).toHaveBeenCalledOnce()
    markReady()
    await Promise.all([first, second])

    expect(values.get("alice")?.value).toBe(3)
    expect(collection.utils.writeBatch).toHaveBeenCalledTimes(3)
  })

  it("derives a queued snapshot from restored rows after initialization", async () => {
    const { markReady, registry, values } = queryCollectionFixture()
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
    markReady()
    await committed

    expect([...values.values()]).toEqual([
      { id: "restored", value: 1 },
      { id: "network", value: 2 },
    ])
  })

  it("replaces stale rows and fields through one QueryCollection batch", async () => {
    const { collection, markReady, registry, values } = queryCollectionFixture()
    markReady()
    values.set("alice", { id: "alice", value: 1, extra: "stale" })
    values.set("bob", { id: "bob", value: 1 })

    await writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )

    expect([...values.values()]).toEqual([{ id: "alice", value: 2 }])
    expect(collection.utils.writeDelete).toHaveBeenCalledWith(["bob"])
    expect(collection.utils.writeUpsert).toHaveBeenCalledWith([{ id: "alice", value: 2 }])
  })

  it("fences an initializing write when the registry generation fails", async () => {
    const { failGeneration, markReady, registry, values } = queryCollectionFixture()
    const first = writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 1 }],
      (row) => row.id,
    )
    const failure = new Error("generation failed")
    failGeneration(failure)
    markReady()

    await expect(first).rejects.toBe(failure)
    await expect(writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 2 }],
      (row) => row.id,
    )).rejects.toBe(failure)
    expect(values.size).toBe(0)
  })

  it("rejects a collection that is not backed by a QueryCollection", () => {
    const registry = {
      collections: { profiles: { keys: () => new Map().keys(), utils: {} } },
      assertGenerationActive: vi.fn(),
    }

    expect(() => writeCommunityCollectionRows(
      registry as never,
      "profiles",
      [{ id: "alice", value: 1 }],
      (row) => row.id,
    )).toThrow("Collection profiles is not backed by a QueryCollection")
  })
})
