import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@alook/shared"

type Row = Record<string, unknown>
type FakeOptions = {
  id: string
  getKey: (row: Row) => string
  durable: boolean
}

const fake = vi.hoisted(() => ({
  durableStores: new Map<string, Map<string, Row>>(),
  failAccept: false,
  preloadFailures: new Map<string, number>(),
  warnings: vi.fn(),
}))

vi.mock("@tanstack/browser-db-sqlite-persistence", () => ({
  persistedCollectionOptions: (options: Omit<FakeOptions, "durable">) => ({
    ...options,
    durable: true,
  }),
}))

vi.mock("@tanstack/react-db", () => ({
  localOnlyCollectionOptions: (options: Omit<FakeOptions, "durable">) => ({
    ...options,
    durable: false,
  }),
  createCollection: (options: FakeOptions) => {
    const rows = options.durable
      ? (fake.durableStores.get(options.id) ?? new Map<string, Row>())
      : new Map<string, Row>()
    if (options.durable) fake.durableStores.set(options.id, rows)
    return {
      preload: () => {
        const remaining = fake.preloadFailures.get(options.id) ?? 0
        if (remaining === 0) return Promise.resolve()
        fake.preloadFailures.set(options.id, remaining - 1)
        return Promise.reject(new Error(`preload failed: ${options.id}`))
      },
      cleanup: () => Promise.resolve(),
      keys: () => rows.keys(),
      values: () => rows.values(),
      entries: () => rows.entries(),
      has: (key: string) => rows.has(key),
      get: (key: string) => rows.get(key),
      insert: (row: Row) => rows.set(options.getKey(row), { ...row }),
      update: (key: string, update: (row: Row) => void) => {
        const row = rows.get(key)
        if (row) update(row)
      },
      delete: (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) rows.delete(key)
      },
      utils: {
        acceptMutations: () => fake.failAccept
          ? Promise.reject(new Error("persist failed"))
          : Promise.resolve(),
      },
    }
  },
  createTransaction: ({ mutationFn }: {
    mutationFn: (args: { transaction: { mutations: [] } }) => Promise<void>
  }) => {
    let persisted = Promise.resolve()
    return {
      mutate: (mutate: () => void) => {
        mutate()
        persisted = mutationFn({ transaction: { mutations: [] } })
      },
      isPersisted: {
        get promise() {
          return persisted
        },
      },
    }
  },
}))

vi.mock("./browser-persistence", () => ({
  getBrowserPersistenceRuntime: () => Promise.resolve({ persistence: {} }),
  registerPersistenceClearScope: () => () => {},
}))

const scope = { accountId: "account-a", workspaceId: "workspace-a" }

function collectionId(name: string) {
  return `agent-chat:${JSON.stringify([scope.accountId, scope.workspaceId])}:${name}`
}

function message(id: string): Message {
  return {
    id,
    conversation_id: "conversation-1",
    role: "user",
    content: id,
    task_id: null,
    attachment_ids: null,
    created_at: "2026-01-01T00:00:00.000Z",
  }
}

beforeEach(() => {
  fake.durableStores.clear()
  fake.failAccept = false
  fake.preloadFailures.clear()
  fake.warnings.mockClear()
  vi.spyOn(console, "warn").mockImplementation(fake.warnings)
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Agent chat persistence fallbacks", () => {
  it("falls back when the durable scope manifest cannot preload", async () => {
    fake.preloadFailures.set("agent-chat:scope-manifest:v1", 1)
    const persistence = await import("./agent-chat-persistence")

    await persistence.openAgentChatPersistence(scope)

    expect(fake.warnings).toHaveBeenCalledWith(
      "[Alook persistence] Agent scope manifest failed; using memory only",
      expect.any(Error),
    )
  })

  it("falls back when a durable account registry cannot preload", async () => {
    fake.preloadFailures.set(collectionId("messages"), 1)
    const persistence = await import("./agent-chat-persistence")

    await persistence.mergeCachedMessages(
      "conversation-1",
      [message("message-1")],
      false,
      scope,
    )

    expect((await persistence.getCachedMessages("conversation-1", scope))?.[0]?.id)
      .toBe("message-1")
    expect(fake.warnings).toHaveBeenCalledWith(
      "[Alook persistence] Agent cache preload failed; using memory only",
      expect.any(Error),
    )
  })

  it("returns safe reads after a registry fails in both durable and memory modes", async () => {
    fake.preloadFailures.set(collectionId("messages"), 2)
    const persistence = await import("./agent-chat-persistence")
    await expect(persistence.openAgentChatPersistence(scope)).rejects.toThrow("preload failed")

    expect(await persistence.getCachedMessages("conversation-1", scope)).toBeNull()
    expect(await persistence.getCachedMessagesBefore(
      "conversation-1",
      "2026-01-01T00:00:00.000Z",
      "message-1",
      10,
      scope,
    )).toBeNull()
    expect(await persistence.getCacheMeta("conversation-1", scope)).toBeNull()
    expect(await persistence.getLastOpenConversation("agent-1", null, scope)).toBeNull()
    expect(await persistence.getConvExtras("conversation-1", scope)).toBeNull()
  })

  it("reports every account scope that could not be cleared", async () => {
    const persistence = await import("./agent-chat-persistence")
    await persistence.mergeCachedMessages(
      "conversation-1",
      [message("message-1")],
      false,
      scope,
    )
    fake.failAccept = true

    await expect(persistence.clearAgentChatPersistenceForAccount(scope.accountId))
      .rejects.toThrow("Failed to clear all Agent chat persistence scopes")
  })
})
