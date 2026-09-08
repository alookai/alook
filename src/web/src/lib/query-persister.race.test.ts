import "fake-indexeddb/auto"
import { describe, expect, it, vi } from "vitest"
import type { PersistedClient } from "@tanstack/react-query-persist-client"

const controls = vi.hoisted(() => ({
  blockNextSet: false,
  releaseSet: null as (() => void) | null,
  setStarted: null as (() => void) | null,
}))

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>()
  return {
    ...actual,
    set: vi.fn(async (...args: Parameters<typeof actual.set>) => {
      if (controls.blockNextSet) {
        controls.blockNextSet = false
        controls.setStarted?.()
        await new Promise<void>((resolve) => {
          controls.releaseSet = resolve
        })
      }
      return actual.set(...args)
    }),
  }
})

import { get } from "idb-keyval"
import { clearPersistedCache, createIdbPersister } from "./query-persister"

describe("createIdbPersister — logout race", () => {
  it("makes clear the final operation after an already-started write", async () => {
    const userId = "u_inflight_logout"
    await clearPersistedCache(userId)
    const stale = createIdbPersister(userId)
    const writeStarted = new Promise<void>((resolve) => {
      controls.setStarted = resolve
    })
    controls.blockNextSet = true

    const client: PersistedClient = {
      timestamp: 1,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    }
    const pendingWrite = stale.persistClient(client)
    await writeStarted

    // Model QueryProvider retaining a persister from an older client chunk
    // while logout imports a freshly evaluated copy of this module.
    vi.resetModules()
    const { clearPersistedCache: clearFromReloadedModule } = await import("./query-persister")
    const pendingClear = clearFromReloadedModule(userId)
    controls.releaseSet?.()
    await Promise.all([pendingWrite, pendingClear])

    expect(await get(`alook:qc:v1:${userId}:client`)).toBeUndefined()
  })
})
