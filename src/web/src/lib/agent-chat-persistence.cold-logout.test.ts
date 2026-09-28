import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@alook/shared"

type Row = Record<string, unknown>
type FakeOptions = {
  id: string
  getKey: (row: Row) => string
  durable: boolean
}

const fake = vi.hoisted(() => ({
  durableStores: new Map<string, Map<string, Row>>(),
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
      get size() {
        return rows.size
      },
      preload: () => Promise.resolve(),
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
      utils: { acceptMutations: () => Promise.resolve() },
    }
  },
  createTransaction: () => ({
    mutate: (mutate: () => void) => mutate(),
    isPersisted: { promise: Promise.resolve() },
  }),
}))

vi.mock("./browser-persistence", () => ({
  getBrowserPersistenceRuntime: () => Promise.resolve({ persistence: {} }),
  registerPersistenceClearScope: () => () => {},
}))

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
  vi.resetModules()
})

describe("Agent chat cold-reload logout", () => {
  it("discovers A from the persisted manifest, clears A, and preserves B", async () => {
    const firstPage = await import("./agent-chat-persistence")
    const accountA = { accountId: "account-a", workspaceId: "shared-workspace" }
    const accountB = { accountId: "account-b", workspaceId: "shared-workspace" }
    await firstPage.mergeCachedMessages(
      "conversation-1",
      [message("message-a")],
      false,
      accountA,
    )
    await firstPage.mergeCachedMessages(
      "conversation-1",
      [message("message-b")],
      false,
      accountB,
    )

    vi.resetModules()
    const logoutPage = await import("./agent-chat-persistence")
    await logoutPage.clearAgentChatPersistenceForAccount("account-a")

    vi.resetModules()
    const nextLogin = await import("./agent-chat-persistence")
    expect(await nextLogin.getCachedMessages("conversation-1", accountA)).toBeNull()
    expect((await nextLogin.getCachedMessages("conversation-1", accountB))?.[0]?.id)
      .toBe("message-b")
  })
})
