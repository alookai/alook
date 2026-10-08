import "fake-indexeddb/auto"
import React from "react"
import { openDB } from "idb"
import { del, get, set } from "idb-keyval"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { AdvancedSettings } from "./user-settings"
import { tid } from "@/lib/community/testids"
import { clearPersistedCache, getPersistedCacheSizeBytes } from "@/lib/query-persister"

const databases: string[] = []
const connections: Array<{ close: () => void }> = []
async function seed(name: string) {
  databases.push(name)
  const db = await openDB(name, 4, { upgrade(db) {
    for (const table of ["messages", "cache_meta", "last_open", "conv_extras"]) db.createObjectStore(table)
  } })
  connections.push(db)
  for (const table of db.objectStoreNames) await db.put(table, { text: "旧聊天", marker: table }, table)
  return db
}
function mount() {
  const client = new QueryClient()
  const result = render(<QueryClientProvider client={client}><AdvancedSettings /></QueryClientProvider>)
  return { ...result, client }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const key of ["alook:qc:v1:settings:client", "alook:qc:v3:settings:client", "alook:qc:v99:settings:application:client", "settings-unrelated"]) await del(key)
  for (const db of connections.splice(0)) db.close()
  for (const name of databases.splice(0)) await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
})
describe("AdvancedSettings legacy device cache", () => {
  it("counts and deletes all four legacy stores through the real confirmation control", async () => {
    const db = await seed("alook-chat-cache-legacy-positive")
    db.close()
    const unrelated = await seed("unrelated-app-cache")
    unrelated.close()
    const cacheNames = new Set(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"])
    const storage = { keys: vi.fn(async () => [...cacheNames]), delete: vi.fn(async (name: string) => cacheNames.delete(name)),
      open: vi.fn(async () => ({ keys: async () => [new Request("https://example.test/asset")], match: async () => new Response("你好") })) }
    vi.stubGlobal("caches", storage)
    await set("alook:qc:v1:settings:client", "old")
    await set("alook:qc:v3:settings:client", "你好")
    await set("alook:qc:v99:settings:application:client", "future")
    await set("settings-unrelated", "keep")
    expect(await getPersistedCacheSizeBytes()).toBe(33 + ["messages", "cache_meta", "last_open", "conv_extras"].reduce((sum, table) => sum + new TextEncoder().encode(JSON.stringify({ text: "旧聊天", marker: table })).byteLength, 0))
    mount()
    await waitFor(() => expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("Calculating"))
    expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("0 B")
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Clear local cache" }))
    await user.click(screen.getByRole("button", { name: "Clear cache" }))
    await waitFor(() => expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("0 B"))
    expect(cacheNames).toEqual(new Set(["unrelated-cache"]))
    for (const key of ["alook:qc:v1:settings:client", "alook:qc:v3:settings:client", "alook:qc:v99:settings:application:client"]) expect(await get(key)).toBeUndefined()
    expect(await get("settings-unrelated")).toBe("keep")
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain("alook-chat-cache-legacy-positive")
    expect((await indexedDB.databases()).map((db) => db.name)).toContain("unrelated-app-cache")
  })
  it("reports a blocked old connection without replacing its size with zero", async () => {
    await seed("alook-chat-cache-legacy-blocked")
    mount()
    await waitFor(() => expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("Calculating"))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Clear local cache" }))
    await user.click(screen.getByRole("button", { name: "Clear cache" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("other tabs"))
    expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("0 B")
  })
  it("reports unavailable enumeration instead of claiming a complete device clear", async () => {
    vi.spyOn(indexedDB, "databases").mockImplementation(() => Promise.reject(new Error("Enumeration unavailable")))
    mount()
    await waitFor(() => expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("Unavailable"))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Clear local cache" }))
    await user.click(screen.getByRole("button", { name: "Clear cache" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be listed"))
    expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("0 B")
  })
  it("reports a public cache deletion failure after completing legacy cleanup", async () => {
    const db = await seed("alook-chat-cache-legacy-public-failure")
    db.close()
    vi.stubGlobal("caches", { keys: vi.fn(async () => ["alook-public-precache-v1"]),
      open: vi.fn(async () => ({ keys: async () => [new Request("https://example.test/asset")], match: async () => new Response("public") })),
      delete: vi.fn(async () => { throw new Error("Public files could not be cleared") }) })
    mount()
    await waitFor(() => expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("Calculating"))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Clear local cache" }))
    await user.click(screen.getByRole("button", { name: "Clear cache" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Public files could not be cleared"))
    expect(screen.getByTestId(tid.settingsCacheSize)).not.toHaveTextContent("0 B")
    expect((await indexedDB.databases()).map(db => db.name)).not.toContain("alook-chat-cache-legacy-public-failure")
  })
  it("keeps the unqualified legacy workspace database during account-only clear", async () => {
    const db = await seed("alook-chat-cache-legacy-account-boundary")
    db.close()
    const deleteCache = vi.fn()
    vi.stubGlobal("caches", { keys: vi.fn(async () => ["alook-public-precache-v99"]), delete: deleteCache })
    await clearPersistedCache("account-A")
    expect(deleteCache).not.toHaveBeenCalled()
    expect((await indexedDB.databases()).map((db) => db.name)).toContain("alook-chat-cache-legacy-account-boundary")
  })
})
