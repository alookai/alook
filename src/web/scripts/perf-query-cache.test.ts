import { IDBFactory } from "fake-indexeddb"
import { createStore, get, set } from "idb-keyval"
import { readFileSync } from "node:fs"
import { ScriptTarget, ModuleKind, transpileModule } from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createIdbPersister, PERSIST_BUSTER, PERSIST_CACHE_PREFIX, PERSIST_VERSION } from "../src/lib/query-persister"
import { communityKeys } from "../src/lib/query-keys"
import { operatePerfQueryCache } from "../src/test/e2e-ui/perf/perf-query-cache"

let store: ReturnType<typeof createStore>
const key = `${PERSIST_CACHE_PREFIX}:viewer:client`
const expected = {
  key,
  action: "contains" as const,
  version: PERSIST_VERSION,
  buster: PERSIST_BUSTER,
  queryKey: communityKeys.communityDbCollection("viewer", "messages"),
  channelIds: ["reload", "disk-target"],
}
const snapshot = () => ({
  version: PERSIST_VERSION,
  buster: PERSIST_BUSTER,
  channelFences: [],
  clientState: {
    queries: [{
      queryKey: [...expected.queryKey] as unknown[],
      state: { status: "success", data: [{ id: "r1", channelId: "reload" }, { id: "r2", channelId: "disk-target" }] },
    }],
  },
})

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  store = createStore("keyval-store", "keyval")
})
afterEach(() => vi.unstubAllGlobals())

describe("perf switch current disk qualification", () => {
  it.each(["contains", "remove"] as const)("allows the first current persister write after %s starts without a database", async action => {
    expect(await operatePerfQueryCache(action === "contains" ? expected : { key, action })).toBe(action === "remove")
    vi.resetModules()
    const { createIdbPersister: createFreshPersister } = await import("../src/lib/query-persister")
    const persister = createFreshPersister("viewer")
    expect(await persister.isCurrent()).toBe(true)
    await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: { mutations: [], queries: [] } })
    await vi.waitFor(async () => {
      const raw = await get<string>(key, store)
      expect(JSON.parse(raw ?? "null")).toMatchObject({ version: PERSIST_VERSION, buster: PERSIST_BUSTER })
    }, { timeout: 2_000 })
  })

  it("executes the browser-serialized operation against the actual canonical collection rows", async () => {
    await set(key, JSON.stringify(snapshot()), store)
    expect(await operatePerfQueryCache(expected)).toBe(true)
    const source = readFileSync(new URL("../src/test/e2e-ui/perf/perf-query-cache.ts", import.meta.url), "utf8")
    const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.CommonJS } }).outputText
    const exports = {} as { operatePerfQueryCache: typeof operatePerfQueryCache }
    new Function("exports", compiled)(exports)
    const browserOperation = new Function(`return (${exports.operatePerfQueryCache.toString()})`)() as typeof operatePerfQueryCache
    expect(await browserOperation(expected)).toBe(true)
  })

  it.each(["version", "buster", "fences", "account", "transport", "missing-target", "row-id", "pending"])("rejects %s instead of recording a false disk-warm result", async variant => {
    const value = snapshot()
    const query = value.clientState.queries[0]
    if (variant === "version") value.version -= 1
    if (variant === "buster") value.buster = "obsolete"
    if (variant === "fences") Reflect.deleteProperty(value, "channelFences")
    if (variant === "account") query.queryKey = communityKeys.communityDbCollection("another-viewer", "messages")
    if (variant === "transport") query.queryKey = ["community", "channel", "disk-target", "messages"]
    if (variant === "missing-target") query.state.data = query.state.data.slice(0, 1)
    if (variant === "row-id") query.state.data[1].id = ""
    if (variant === "pending") query.state.status = "pending"
    await set(key, JSON.stringify(value), store)
    expect(await operatePerfQueryCache(expected)).toBe(false)
  })

  it.each(["{", "null", "[]", "{}"]) ("waits for a current payload after malformed value %s", async value => {
    await set(key, value, store)
    expect(await operatePerfQueryCache(expected)).toBe(false)
  })

  it("rejects an absent payload and an empty target set", async () => {
    await set("unrelated", "value", store)
    expect(await operatePerfQueryCache(expected)).toBe(false)
    await set(key, JSON.stringify(snapshot()), store)
    expect(await operatePerfQueryCache({ ...expected, channelIds: [] })).toBe(false)
  })

  it("rejects a database without the query store while preserving its other store", async () => {
    const otherFamily = createStore("keyval-store", "another-family")
    await set("sentinel", { value: "keep" }, otherFamily)
    await expect(operatePerfQueryCache(expected)).rejects.toThrow("query cache store unavailable")
    await expect(operatePerfQueryCache({ key, action: "remove" })).rejects.toThrow("query cache store unavailable")
    expect(await get("sentinel", otherFamily)).toEqual({ value: "keep" })
  })

  it("removes only the measured account payload and leaves the captured writer eligible", async () => {
    const persister = createIdbPersister("viewer")
    expect(await persister.isCurrent()).toBe(true)
    const retained = new Map<string, unknown>([
      ["alook:qc:device-epoch", await get("alook:qc:device-epoch", store)],
      [`${PERSIST_CACHE_PREFIX}:viewer:account-epoch`, await get(`${PERSIST_CACHE_PREFIX}:viewer:account-epoch`, store)],
      [`${PERSIST_CACHE_PREFIX}:viewer:account-epoch:channels`, await get(`${PERSIST_CACHE_PREFIX}:viewer:account-epoch:channels`, store)],
      [`${key}:epoch`, await get(`${key}:epoch`, store)],
      [`${PERSIST_CACHE_PREFIX}:another-viewer:client`, "other payload"],
      ["another-cache-family", "other family"],
    ])
    for (const [retainedKey, value] of retained) await set(retainedKey, value, store)
    await set(key, JSON.stringify(snapshot()), store)
    expect(await operatePerfQueryCache({ key, action: "remove" })).toBe(true)
    expect(await get(key, store)).toBeUndefined()
    for (const [retainedKey, value] of retained) expect(await get(retainedKey, store)).toEqual(value)
    expect(await persister.isCurrent()).toBe(true)
    await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: { mutations: [], queries: [] } })
    await vi.waitFor(async () => {
      const raw = await get<string>(key, store)
      expect(JSON.parse(raw ?? "null")).toMatchObject({ version: PERSIST_VERSION, buster: PERSIST_BUSTER })
    }, { timeout: 2_000 })
  })

  it("reports open failure instead of claiming cold or warm cache success", async () => {
    const failure = new DOMException("storage unavailable", "UnknownError")
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { error: failure, onerror: null as (() => void) | null }
      queueMicrotask(() => request.onerror?.())
      return request
    } })
    await expect(operatePerfQueryCache(expected)).rejects.toThrow("storage unavailable")
    await expect(operatePerfQueryCache({ key, action: "remove" })).rejects.toThrow("storage unavailable")
  })
})
