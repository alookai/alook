import { QueryClient } from "@tanstack/react-query"
import {
  BasicIndex,
  BTreeIndex,
  createCollection,
  createLiveQueryCollection,
  eq,
  parseLoadSubsetOptions,
} from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence"
import { z } from "zod"
import type { SpikeLogEntry, SpikeSnapshot } from "./test-api"

const serverSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
})
const messageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  seq: z.number().int(),
  text: z.string(),
})

type ServerRow = z.output<typeof serverSchema>
type MessageRow = z.output<typeof messageSchema>
type FreshnessReason = "reconnect" | "gap" | "unknown"
type WsEvent =
  | { type: "upsert"; account: string; servers: ServerRow[]; messages: MessageRow[] }
  | { type: "revoke"; account: string; serverId: string; channelIds: string[] }
  | { type: "freshness"; account: string; reason: FreshnessReason }
type HotApi = {
  on: (event: string, listener: (payload: WsEvent) => void) => void
  off: (event: string, listener: (payload: WsEvent) => void) => void
}

const capabilityGap = "@tanstack/query-db-collection@1.2.15 does not export documented createCursorPager"
const query = new URLSearchParams(location.search)
const databaseScope = query.get("db") ?? crypto.randomUUID()
const logs: SpikeLogEntry[] = []
let account = "alpha"
let offline = false
let generation = 0
let runtime: Runtime | null = null
let pendingLifecycle: Promise<void> = Promise.resolve()
let lastWsEvent: Extract<WsEvent, { type: "upsert" }> | null = null
let messageLimit = 2

const element = <T = HTMLElement>(testId: string) => {
  const found = document.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!found) throw new Error(`missing ${testId}`)
  return found
}

const accountSelect = element<HTMLSelectElement>("account")
const channelSelect = element<HTMLSelectElement>("channel-select")
const runtimeState = element("runtime-state")
const serverState = element("servers-state")
const messageState = element("messages-window")
const eventLog = element("event-log")
const capabilityState = element("capability-state")

function record(kind: string, detail: Record<string, unknown> = {}) {
  logs.push({ kind, detail, generation, time: new Date().toISOString() })
  eventLog.textContent = logs.map((entry) => JSON.stringify(entry)).join("\n")
}

function rowsWithoutVirtual<T extends object>(rows: T[]): T[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith("$")),
  ) as T)
}

function render() {
  const servers = rowsWithoutVirtual((runtime?.servers.toArray ?? []) as unknown as ServerRow[])
    .sort((left, right) => left.id.localeCompare(right.id))
  const messages = rowsWithoutVirtual((runtime?.messageView.toArray ?? []) as unknown as MessageRow[])
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
  serverState.textContent = JSON.stringify(servers, null, 2)
  messageState.textContent = JSON.stringify(messages, null, 2)
  capabilityState.textContent = capabilityGap
  runtimeState.textContent = runtime
    ? `ready account=${account} generation=${generation} offline=${offline}`
    : `closed account=${account} generation=${generation} offline=${offline}`
  runtimeState.dataset.state = runtime ? "ready" : "closed"
}

async function fetchRows<T>(url: string, signal?: AbortSignal): Promise<T[]> {
  if (offline) throw new TypeError("synthetic offline")
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  const data = await response.json() as { rows: T[] }
  return data.rows
}

async function createRuntime(targetAccount: string) {
  const currentGeneration = ++generation
  const generationState = { active: true }
  record("runtime-open-start", { account: targetAccount, databaseScope })
  const dbName = `alook-official-spike-${databaseScope}-${targetAccount}`
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `${dbName}.sqlite` })
  const coordinator = new BrowserCollectionCoordinator({ dbName })
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator,
    schemaMismatchPolicy: "reset",
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 60_000 } },
  })

  const serverOptions = persistedCollectionOptions({
    ...queryCollectionOptions({
      id: `official-spike:${targetAccount}:servers`,
      queryClient,
      queryKey: ["official-spike", targetAccount, "servers"],
      queryFn: async ({ signal }) => {
        const rows = await fetchRows<ServerRow>(`/spike-api/accounts/${targetAccount}/servers`, signal)
        if (!generationState.active) throw new DOMException("stale runtime", "AbortError")
        record("rest-servers", { account: targetAccount, count: rows.length })
        return rows
      },
      schema: serverSchema,
      getKey: (row) => row.id,
      staleTime: 0,
    }),
    persistence,
    schemaVersion: 1,
  })
  const servers = createCollection({ ...serverOptions, schema: serverSchema })

  const messageOptions = persistedCollectionOptions({
    ...queryCollectionOptions({
      id: `official-spike:${targetAccount}:messages`,
      queryClient,
      queryKey: ["official-spike", targetAccount, "messages", "rows"],
      queryFn: async (context) => {
        const loadSubsetOptions = context.meta?.loadSubsetOptions
        const parsed = parseLoadSubsetOptions(loadSubsetOptions)
        const channelFilter = parsed.filters.find((filter) => (
          filter.field.at(-1) === "channelId" && filter.operator === "eq"
        ))
        if (typeof channelFilter?.value !== "string") throw new Error("channelId equality demand required")
        const offset = loadSubsetOptions?.offset ?? 0
        const limit = parsed.limit ?? 100
        const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
        const rows = await fetchRows<MessageRow>(
          `/spike-api/accounts/${targetAccount}/channels/${channelFilter.value}/messages?${params}`,
          context.signal,
        )
        if (!generationState.active) throw new DOMException("stale runtime", "AbortError")
        record("rest-messages", {
          account: targetAccount,
          channelId: channelFilter.value,
          limit,
          offset,
          sorts: parsed.sorts,
        })
        return rows
      },
      schema: messageSchema,
      getKey: (row) => row.id,
      syncMode: "on-demand",
      staleTime: 0,
    }),
    persistence,
    schemaVersion: 1,
  })
  const messages = createCollection({ ...messageOptions, schema: messageSchema })
  messages.createIndex((row) => row.channelId, { indexType: BasicIndex })
  messages.createIndex((row) => row.seq, { indexType: BTreeIndex })

  const messageView = createLiveQueryCollection({
    id: `official-spike:${targetAccount}:message-view:${channelSelect.value}:${messageLimit}:${currentGeneration}`,
    query: (builder) => builder
      .from({ message: messages })
      .where(({ message }) => eq(message.channelId, channelSelect.value))
      .orderBy(({ message }) => message.seq, "desc")
      .limit(messageLimit),
  })
  const serverSubscription = servers.subscribeChanges(render, { includeInitialState: true })
  const messageSubscription = messageView.subscribeChanges(render, { includeInitialState: true })
  const preloadResults = await Promise.allSettled([servers.preload(), messageView.preload()])
  record("runtime-preload", {
    account: targetAccount,
    results: preloadResults.map((result) => result.status),
    serverCount: servers.size,
    messageCount: messages.size,
  })

  let coalescedRefetch: Promise<void> | null = null
  const requestFreshness = () => {
    coalescedRefetch ??= Promise.resolve().then(async () => {
      record("refetch-start", { account: targetAccount })
      await servers.utils.refetch({ throwOnError: true })
      if (!generationState.active) return
      render()
      record("refetch-applied", { account: targetAccount, count: servers.size })
    }).finally(() => {
      coalescedRefetch = null
    })
    return coalescedRefetch
  }

  const close = async () => {
    if (!generationState.active) return
    generationState.active = false
    record("runtime-close-start", { account: targetAccount })
    queryClient.cancelQueries()
    serverSubscription.unsubscribe()
    messageSubscription.unsubscribe()
    await Promise.allSettled([messageView.cleanup(), messages.cleanup(), servers.cleanup()])
    coordinator.dispose()
    await Promise.resolve(database.close?.()).catch((error: unknown) => {
      record("database-close-error", { error: String(error) })
    })
    queryClient.clear()
    record("runtime-closed", { account: targetAccount })
  }

  record("runtime-opened", {
    account: targetAccount,
    coordinator: {
      isLeader: coordinator.isLeader(servers.id),
      nodeId: coordinator.getNodeId(),
    },
  })
  return {
    close,
    generation: currentGeneration,
    messageView,
    messages,
    requestFreshness,
    servers,
    waitForIdle: () => coalescedRefetch ?? Promise.resolve(),
  }
}

type Runtime = Awaited<ReturnType<typeof createRuntime>>

async function rebuild() {
  runtimeState.textContent = `rebuilding account=${account}`
  const previous = runtime
  runtime = null
  render()
  await previous?.close()
  runtime = await createRuntime(account)
  render()
}

async function replaceMessageView() {
  await rebuild()
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`${response.status} ${path}`)
  return response.json() as Promise<T>
}

async function sendWs(event: WsEvent) {
  await post("/spike-api/control/ws", event)
}

function applyWsEvent(event: WsEvent) {
  if (!runtime || event.account !== account) return
  if (event.type === "freshness") {
    record("freshness-signal", { account, reason: event.reason })
    void runtime.requestFreshness().catch((error: unknown) => {
      record("freshness-error", { account, reason: event.reason, error: String(error) })
    })
    return
  }
  if (event.type === "upsert") {
    runtime.servers.utils.writeBatch(() => {
      runtime?.servers.utils.writeUpsert(event.servers)
    })
    runtime.messages.utils.writeBatch(() => {
      runtime?.messages.utils.writeUpsert(event.messages)
    })
  } else {
    const serverKeys = event.serverId && runtime.servers.has(event.serverId) ? [event.serverId] : []
    const messageKeys = runtime.messages.toArray
      .filter((row) => event.channelIds.includes(row.channelId))
      .map((row) => row.id)
    if (serverKeys.length > 0) runtime.servers.utils.writeDelete(serverKeys)
    if (messageKeys.length > 0) runtime.messages.utils.writeDelete(messageKeys)
  }
  render()
  record("ws-write-batch", {
    account,
    event: event.type,
    messages: event.type === "upsert" ? event.messages.length : event.channelIds.length,
    servers: event.type === "upsert" ? event.servers.length : 1,
  })
}

const hot = (import.meta as ImportMeta & { hot?: HotApi }).hot
const onHotWs = (event: WsEvent) => {
  record("ws-frame", { account: event.account, event: event.type })
  applyWsEvent(event)
}
hot?.on("spike:ws", onHotWs)

element<HTMLButtonElement>("offline-toggle").addEventListener("click", () => {
  offline = !offline
  element<HTMLButtonElement>("offline-toggle").textContent = offline ? "Go online" : "Go offline"
  record("offline-changed", { offline })
  render()
})
element("rebuild-runtime").addEventListener("click", () => {
  pendingLifecycle = pendingLifecycle.then(rebuild)
})
element("account-switch").addEventListener("click", () => {
  account = account === "alpha" ? "beta" : "alpha"
  accountSelect.value = account
  channelSelect.value = account === "alpha" ? "c-alpha" : "c-beta"
  messageLimit = 2
  pendingLifecycle = pendingLifecycle.then(rebuild)
})
accountSelect.addEventListener("change", () => {
  account = accountSelect.value
  channelSelect.value = account === "alpha" ? "c-alpha" : "c-beta"
  messageLimit = 2
  pendingLifecycle = pendingLifecycle.then(rebuild)
})
channelSelect.addEventListener("change", () => {
  messageLimit = 2
  pendingLifecycle = pendingLifecycle.then(replaceMessageView)
})
element("load-next-window").addEventListener("click", () => {
  messageLimit += 2
  pendingLifecycle = pendingLifecycle.then(replaceMessageView)
})
element("ws-apply").addEventListener("click", () => {
  const channelId = account === "alpha" ? "c-alpha" : "c-beta"
  lastWsEvent = {
    type: "upsert",
    account,
    servers: [{ id: `s-live-${account}`, name: `Live ${account}`, version: 2 }],
    messages: [{ id: `m-live-${account}`, channelId, seq: 99, text: `live ${account}` }],
  }
  pendingLifecycle = pendingLifecycle.then(() => sendWs(lastWsEvent!))
})
element("duplicate-replay").addEventListener("click", () => {
  const event = lastWsEvent ?? {
    type: "upsert" as const,
    account,
    servers: [{ id: `s-live-${account}`, name: `Live ${account}`, version: 2 }],
    messages: [{
      id: `m-live-${account}`,
      channelId: account === "alpha" ? "c-alpha" : "c-beta",
      seq: 99,
      text: `live ${account}`,
    }],
  }
  pendingLifecycle = pendingLifecycle.then(() => sendWs(event))
})
element("freshness-burst").addEventListener("click", () => {
  pendingLifecycle = pendingLifecycle.then(async () => {
    await post("/spike-api/control/freshness-burst", {
      account,
      server: { id: `s-fresh-${account}`, name: `Fresh ${account}`, version: 3 },
    })
  })
})
element("revoke-scope").addEventListener("click", () => {
  const serverId = account === "alpha" ? "s-alpha" : "s-beta"
  const channelIds = [account === "alpha" ? "c-alpha" : "c-beta"]
  pendingLifecycle = pendingLifecycle.then(() => sendWs({ type: "revoke", account, serverId, channelIds }))
})

async function handlePageHide() {
  record("pagehide", { persisted: true })
  const previous = runtime
  runtime = null
  render()
  await previous?.close()
}

async function handlePersistedPageShow() {
  record("pageshow", { persisted: true })
  if (!runtime) runtime = await createRuntime(account)
  render()
}

element("simulate-pagehide").addEventListener("click", () => {
  pendingLifecycle = pendingLifecycle.then(handlePageHide)
})
element("simulate-pageshow-persisted").addEventListener("click", () => {
  pendingLifecycle = pendingLifecycle.then(handlePersistedPageShow)
})
window.addEventListener("pagehide", (event) => {
  if (!(event as PageTransitionEvent).persisted) return
  pendingLifecycle = pendingLifecycle.then(handlePageHide)
})
window.addEventListener("pageshow", (event) => {
  if (!(event as PageTransitionEvent).persisted) return
  pendingLifecycle = pendingLifecycle.then(handlePersistedPageShow)
})

window.__tanstackOfficialSpike = {
  applyLocalServer: (row) => {
    if (!runtime) throw new Error("runtime is closed")
    runtime.servers.utils.writeUpsert(row)
    render()
    record("local-server-write", { id: row.id })
  },
  rebuild,
  snapshot: (): SpikeSnapshot => ({
    account,
    capabilityGap,
    generation,
    logs: [...logs],
    messages: rowsWithoutVirtual((runtime?.messageView.toArray ?? []) as unknown as MessageRow[]),
    offline,
    servers: rowsWithoutVirtual((runtime?.servers.toArray ?? []) as unknown as ServerRow[]),
  }),
  waitForIdle: async () => {
    await pendingLifecycle
    await runtime?.waitForIdle()
  },
}

render()
pendingLifecycle = rebuild().catch((error) => {
  runtimeState.textContent = String(error)
  runtimeState.dataset.state = "error"
  record("runtime-error", { error: String(error) })
})
