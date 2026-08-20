import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import {
  clearPersistedQueryCache,
  createUserScopedIdbPersister,
} from "./idb-persister"

function persistedClient(timestamp: number): PersistedClient {
  return {
    timestamp,
    buster: "test",
    clientState: { mutations: [], queries: [] },
  }
}

describe("user-scoped IDB persister", () => {
  beforeEach(async () => {
    await Promise.all([
      clearPersistedQueryCache("platform-alice"),
      clearPersistedQueryCache("platform-bob"),
      clearPersistedQueryCache(null),
    ])
  })

  it("isolates persisted clients by user", async () => {
    const alice = createUserScopedIdbPersister({ userId: "platform-alice" })
    const bob = createUserScopedIdbPersister({ userId: "platform-bob" })

    await alice.persistClient(persistedClient(1))
    await bob.persistClient(persistedClient(2))

    await expect(alice.restoreClient()).resolves.toMatchObject({ timestamp: 1 })
    await expect(bob.restoreClient()).resolves.toMatchObject({ timestamp: 2 })
  })

  it("clears only the selected user namespace", async () => {
    const alice = createUserScopedIdbPersister({ userId: "platform-alice" })
    const bob = createUserScopedIdbPersister({ userId: "platform-bob" })
    await alice.persistClient(persistedClient(1))
    await bob.persistClient(persistedClient(2))

    await clearPersistedQueryCache("platform-alice")

    await expect(alice.restoreClient()).resolves.toBeUndefined()
    await expect(bob.restoreClient()).resolves.toMatchObject({ timestamp: 2 })
  })

  it("supports the persister remove contract", async () => {
    const alice = createUserScopedIdbPersister({ userId: "platform-alice" })
    await alice.persistClient(persistedClient(1))

    await alice.removeClient()

    await expect(alice.restoreClient()).resolves.toBeUndefined()
  })

  it("fences a throttled stale write after explicit cache deletion", async () => {
    const alice = createUserScopedIdbPersister({ userId: "platform-alice" })
    await alice.persistClient(persistedClient(1))

    const throttledWrite = alice.persistClient(persistedClient(2))
    await clearPersistedQueryCache("platform-alice")
    await expect(alice.restoreClient()).resolves.toBeUndefined()

    await throttledWrite

    await expect(alice.restoreClient()).resolves.toBeUndefined()
  })

  it("delegates serialization policy to the caller", async () => {
    const serialize = vi.fn((client: PersistedClient) => JSON.stringify({
      ...client,
      timestamp: client.timestamp + 10,
    }))
    const deserialize = vi.fn((raw: string) => JSON.parse(raw) as PersistedClient)
    const persister = createUserScopedIdbPersister({
      userId: null,
      serialize,
      deserialize,
    })

    await persister.persistClient(persistedClient(5))

    await expect(persister.restoreClient()).resolves.toMatchObject({ timestamp: 15 })
    expect(serialize).toHaveBeenCalledOnce()
    expect(deserialize).toHaveBeenCalledOnce()
  })
})
