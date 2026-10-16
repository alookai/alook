import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { expect, type BrowserContext, type CDPSession, type Page, type Route, type TestInfo, type Worker } from "@playwright/test"
import { readPhaseFile, writePhaseFile } from "../../../../scripts/dev-zone-processes.mjs"
import { publicWorkerRuntimeCacheNames } from "../../../lib/service-worker/cache-identity"
import { isPublicAssetResponse, publicRuntimeAssetKind } from "../../../lib/service-worker/public-cache"
import { publicStaticQaManifest } from "../_setup/services"
import type { PublicStaticPhaseReceipt } from "../_setup/service-lifecycle"
import type { CaseActors, CaseResources } from "./case-fixture"
import { WEB_URL, MACHINE_WS_URL } from "../_setup/paths"
import { communityFrameEvents, proxyCommunityWebSockets } from "./community-ws-proxy"
import { gotoAfterUserWsAuth } from "./actions"
import { tid } from "./testids"

export type ReleaseName = "N" | "Nplus1"
export type QaAsset = { url: string; path: string; zone: "main" | "blog"; bytes: number; sha256: string; kind?: "code" | "fonts" | "images"; precache?: boolean; revision?: string | null }
export type NativeResource = { url: string; bytes: number; sha256: string; fromServiceWorker: boolean }
export type ExpirationRow = { id: string; cacheName: string; url: string; timestamp: number }

export function createPublicStaticForensicRecord(options: { now?: () => number; monotonic?: () => string; limit?: number } = {}) {
  const now = options.now ?? Date.now
  const monotonic = options.monotonic ?? (() => process.hrtime.bigint().toString())
  const limit = options.limit ?? 512
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new Error("Invalid forensic record limit")
  const rows: Array<Record<string, string | number>> = []
  const pending = new Set<number>()
  let sequence = 0, request = 0, dropped = 0, observerFailures = 0
  let phase = "setup"
  const allowedPhases = new Set(["setup", "before", "after", "activated", "cleanup"])
  const record = (event: string, values: Record<string, string | number> = {}) => {
    try {
      if (rows.length >= limit) { dropped++; return }
      rows.push({ ...values, sequence: ++sequence, event, phase, pid: process.pid, unixMS: now(), monotonicNS: monotonic() })
    } catch { observerFailures++ }
  }
  const pathOf = (path: string) => {
    if (["/api/community/machines", "/api/community/machines/pair", "/api/community/daemon/activate"].includes(path)) return path
    if (/^\/api\/community\/machines\/[^/?#]+$/.test(path)) return "/api/community/machines/:owned-machine"
    if (/^\/api\/community\/channels\/[^/?#]+\/messages$/.test(path)) return "/api/community/channels/:owned-channel/messages"
    return "other"
  }
  return {
    phase(value: string) { phase = allowedPhases.has(value) ? value : "unknown" },
    event(value: "ready-send-before" | "ready-send-returned" | "ws-open" | "ws-close" | "cleanup-start" | "activation-committed") { record(value) },
    frame(value: string) { record("ws-frame", { type: value === "machine:heartbeat" ? value : "other" }) },
    start(method: string, path: string) {
      const id = ++request
      pending.add(id)
      record("http-start", { request: id, method: ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ? method : "other", path: pathOf(path) })
      return id
    },
    response(id: number, response: Pick<Response, "status" | "headers">) {
      try {
        const timing = response.headers.get("server-timing") ?? ""
        const metrics: string[] = []
        let start = 0, quoted = false, escaped = false
        if (timing.length <= 4096) for (let index = 0; index < timing.length; index++) {
          const char = timing[index]
          if (escaped) escaped = false
          else if (quoted && char === "\\") escaped = true
          else if (char === '"') quoted = !quoted
          else if (char === "," && !quoted) { metrics.push(timing.slice(start, index).trim()); start = index + 1 }
        }
        if (timing.length <= 4096 && !quoted && !escaped) metrics.push(timing.slice(start).trim())
        else metrics.length = 0
        const named = (name: string) => metrics.filter(metric => metric.split(";", 1)[0]?.trim() === name)
        const sampling = named("alook_sampling"), context = named("alook_server")
        const selected = sampling.length === 1 ? /^alook_sampling;\s*desc="(selected|not_selected|unavailable)"$/.exec(sampling[0]!)?.[1] : undefined
        const parent = context.length === 1 ? /^alook_server;\s*desc="(00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})"$/.exec(context[0]!)?.[1] : undefined
        const server = parent && !/^00-0{32}-/.test(parent) && !/-0{16}-/.test(parent) ? parent : undefined
        record("http-response", { request: id, status: response.status, sampling: selected ?? "unavailable", ...(server ? { serverTraceContext: server } : {}) })
        pending.delete(id)
      } catch { observerFailures++ }
    },
    failed(id: number) { record("http-fetch-error", { request: id }); pending.delete(id) },
    snapshot() { return { schema: 1, clocks: { unixMS: "Date.now; same-host wall clock, not monotonic", monotonicNS: "process.hrtime.bigint; same PID order only" }, qualification: "Local call-site observations only; ready send is not native receive/commit or SQLite concurrency", dropped, observerFailures, pendingRequests: pending.size, complete: dropped === 0 && observerFailures === 0 && pending.size === 0, rows: rows.map(row => ({ ...row })) } },
  }
}

const forensicRecords = new WeakMap<CaseResources, ReturnType<typeof createPublicStaticForensicRecord>>()

export function ownPublicStaticForensics(resources: CaseResources, testInfo: TestInfo) {
  if (process.env.ALOOK_E2E_PUBLIC_STATIC_FORENSICS !== "1" || forensicRecords.has(resources)) return
  const record = createPublicStaticForensicRecord()
  forensicRecords.set(resources, record)
  resources.own(record, async record => {
    forensicRecords.delete(resources)
    await attachQa(testInfo, "original-path-forensic-call-sites", record.snapshot())
  })
}

export function blogBuildIdFromScripts(scripts: string) {
  const normalized = scripts.replace(/\\"/g, '"')
  const ids = [...new Set([...normalized.matchAll(/"b"\s*:\s*"([a-zA-Z0-9_-]+)"/g)].map(match => match[1]))]
  if (ids.length !== 1) throw new Error("Rendered Blog Flight data must identify exactly one actual build ID")
  return ids[0]!
}

export function requiredQaManifest() {
  const manifest = publicStaticQaManifest(false)
  if (!manifest) throw new Error("Supplementary public static QA has no managed release manifest")
  return manifest
}

export function releaseAssets(name: ReleaseName): QaAsset[] {
  return requiredQaManifest().releases[name].assets
}

export function runtimeName(kind: "code" | "fonts" | "images") {
  return publicWorkerRuntimeCacheNames()[kind]
}

export function blocked(testInfo: TestInfo, reason: string): never {
  testInfo.annotations.push({ type: "blocked", description: reason })
  throw new Error(`BLOCKED: ${reason}`)
}

export function createQaPhaseOwner(resources: CaseResources, testInfo: TestInfo) {
  const manifest = requiredQaManifest()
  ownPublicStaticForensics(resources, testInfo)
  const receiptPath = resolve(manifest.controlDirectory, "receipt.json")
  const requestPath = resolve(manifest.controlDirectory, "request.json")
  const caseId = testInfo.testId
  const read = () => {
    const receipt = readPhaseFile(receiptPath) as PublicStaticPhaseReceipt | null
    if (!receipt || receipt.runId !== manifest.runId || receipt.manifestDigest !== manifest.digest || receipt.status !== "ready") throw new Error("Managed phase is absent, foreign or not ready")
    if (receipt.caseId && receipt.caseId !== caseId) throw new Error("Managed release phase belongs to another case")
    return receipt
  }
  let claimed = false
  const command = async (to: ReleaseName, action: "switch" | "release") => {
    const receipt = read()
    if (action === "switch" && receipt.release === to) return
    const remaining = resources.deadline - Date.now()
    if (remaining <= 0) throw new Error("Phase operation exceeded the original case-owner deadline")
    const request = { action, runId: manifest.runId, manifestDigest: manifest.digest, sequence: receipt.sequence + 1, from: receipt.release, to, caseId, deadline: resources.deadline }
    claimed = true
    writePhaseFile(requestPath, request)
    await expect.poll(() => {
      const current = readPhaseFile(receiptPath) as PublicStaticPhaseReceipt | null
      if (current?.status === "failed" || current?.status === "stopped") throw new Error(current.failure ?? "Managed phase owner stopped")
      return current?.runId === manifest.runId && current.manifestDigest === manifest.digest && current.sequence === request.sequence && current.status === "ready" && current.release === to && (action === "release" ? !current.caseId : current.caseId === caseId)
    }, { timeout: remaining }).toBe(true)
    await testInfo.attach(`managed-phase-${request.sequence}`, { body: JSON.stringify(readPhaseFile(receiptPath)), contentType: "application/json" })
    if (action === "release") claimed = false
  }
  const owner = resources.own({}, async () => {
    if (!claimed) return
    if (read().release !== manifest.defaultRelease) await command(manifest.defaultRelease, "switch")
    await command(manifest.defaultRelease, "release")
  })
  return { switchTo: (release: ReleaseName) => command(release, "switch"), current: () => read().release, close: owner.close }
}

export async function rootWorker(page: Page) {
  const script = new URL("/sw.js", page.url()).href
  await expect.poll(() => page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations()
    return registrations.map(value => ({ scope: value.scope, script: value.active?.scriptURL, updateViaCache: value.updateViaCache }))
  })).toEqual([{ scope: new URL("/", page.url()).href, script, updateViaCache: "none" }])
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(script)
}

export async function readNativeResource(page: Page, path: string): Promise<NativeResource> {
  const url = new URL(path, page.url()).href
  let accept: (response: import("@playwright/test").Response) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const observed = new Promise<import("@playwright/test").Response>((resolveResponse, rejectResponse) => { accept = resolveResponse; reject = rejectResponse })
  void observed.catch(() => {})
  const listener = (response: import("@playwright/test").Response) => { if (response.url() === url && response.request().method() === "GET") accept(response) }
  const closed = () => reject(new Error("Owned native resource page closed"))
  page.on("response", listener)
  page.once("close", closed)
  try {
    const [body, response] = await Promise.all([page.evaluate(async target => {
      const response = await fetch(target, { credentials: "omit", cache: "no-store", redirect: "error" })
      if (response.status !== 200) throw new Error(`Public static GET returned ${response.status}`)
      const bytes = await response.arrayBuffer()
      return { bytes: bytes.byteLength, sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("") }
    }, url), observed])
    return { url, ...body, fromServiceWorker: response.fromServiceWorker() }
  } finally { page.off("response", listener); page.off("close", closed) }
}

export async function publicNativeSnapshot(page: Page, onlyCaches?: string[]) {
  return page.evaluate(async onlyCaches => {
    const cachesByName: Record<string, Array<{ url: string; bytes: number; sha256: string; date: string | null }>> = {}
    for (const name of await caches.keys()) {
      if (onlyCaches && !onlyCaches.includes(name)) continue
      const cache = await caches.open(name)
      cachesByName[name] = []
      for (const request of await cache.keys()) {
        const response = await cache.match(request)
        if (!response) throw new Error("Native cache entry disappeared during snapshot")
        const bytes = await response.arrayBuffer()
        cachesByName[name].push({ url: request.url, bytes: bytes.byteLength, date: response.headers.get("date"), sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("") })
      }
      cachesByName[name].sort((a, b) => a.url.localeCompare(b.url))
    }
    const databases = await indexedDB.databases()
    const expiration = databases.some(value => value.name === "serwist-expiration") ? await new Promise<Array<{ id: string; cacheName: string; url: string; timestamp: number }>>((resolveRows, reject) => {
      const request = indexedDB.open("serwist-expiration")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains("cache-entries")) { db.close(); reject(new Error("Installed expiration store is absent")); return }
        const tx = db.transaction("cache-entries", "readonly")
        const rows = tx.objectStore("cache-entries").getAll()
        tx.oncomplete = () => { db.close(); resolveRows(rows.result) }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
    }) : []
    return { caches: cachesByName, expiration: expiration.sort((a, b) => a.id.localeCompare(b.id)) }
  }, onlyCaches)
}

export async function seedNativeExpiration(page: Page, cacheName: string, url: string, timestamp: number) {
  if (!Object.values(publicWorkerRuntimeCacheNames()).includes(cacheName)) throw new Error("Artificial age fixture must use a current owned runtime cache")
  return page.evaluate(async ({ cacheName, target, timestamp }) => {
    const url = new URL(target, location.href).href
    const cache = await caches.open(cacheName)
    const response = await cache.match(url)
    if (!response) throw new Error("Age fixture requires a real SW-created cached body")
    const headers = new Headers(response.headers)
    headers.set("date", new Date(timestamp).toUTCString())
    await cache.put(url, new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers }))
    await new Promise<void>((resolveWrite, reject) => {
      const request = indexedDB.open("serwist-expiration")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("cache-entries", "readwrite"), store = tx.objectStore("cache-entries")
        const key = `${cacheName}|${url}`, read = store.get(key)
        read.onsuccess = () => {
          if (!read.result || read.result.cacheName !== cacheName || read.result.url !== url) { tx.abort(); return }
          store.put({ ...read.result, timestamp })
        }
        tx.oncomplete = () => { db.close(); resolveWrite() }
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Owned expiration row is absent")) }
      }
    })
    return { preparation: "artificial aged native state", cacheName, url, timestamp }
  }, { cacheName, target: url, timestamp })
}

export function exactSwRequest(request: { url(): string; serviceWorker(): Worker | null }, url: string, worker: Worker) {
  return request.url() === url && request.serviceWorker() === worker
}

export async function withinQaDeadline<T>(operation: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Owned QA operation cancelled"))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => reject(new Error("Owned QA operation exceeded the original deadline")), Math.max(1, deadline - Date.now()))
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener("abort", abort)
  }
}

export function assertFaultBase(asset: QaAsset | undefined, status: number, headers: Record<string, string>, body: Buffer) {
  if (!asset || status !== 200 || body.length !== asset.bytes || createHash("sha256").update(body).digest("hex") !== asset.sha256
    || !/\bpublic\b/i.test(headers["cache-control"] ?? "") || /\b(?:private|no-store|no-cache)\b/i.test(headers["cache-control"] ?? "")
    || !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(headers["content-type"] ?? "")
    || !isPublicAssetResponse(new Request(new URL(asset.url, WEB_URL)), new Response(null, { status, headers }))) throw new Error("Fault base resource does not match its real bound public JS response")
}

export async function ownSwFault(resources: CaseResources, context: BrowserContext, url: string, candidate: Promise<Worker>, action: "404" | "offline" | "mime" | "private" | "no-store" | "hold", asset?: QaAsset) {
  const records: Array<{ url: string; worker: string; action: string; originalStatus?: number; originalSha256?: string; completed?: boolean }> = []
  let releaseHold: (() => void) | undefined
  let held: Route | undefined
  let disposing = false
  const cancellation = new AbortController()
  const acquisition = { pending: undefined as Promise<void> | undefined }
  const failures: unknown[] = []
  const gate = new Promise<void>(resolveGate => { releaseHold = resolveGate })
  const tasks = new Set<Promise<void>>()
  const handler = (route: Route) => {
    const task = (async () => {
      const request = route.request()
      if (!request.serviceWorker()) { await route.continue(); return }
      let worker: Worker
      try { worker = await withinQaDeadline(candidate, resources.deadline, cancellation.signal) }
      catch (error) { await route.abort("aborted"); if (!disposing) throw error; return }
      if (!exactSwRequest(request, url, worker)) { await route.continue(); return }
      const record: typeof records[number] = { url, worker: request.serviceWorker()!.url(), action }
      records.push(record)
      if (action === "hold") {
        held = route
        await withinQaDeadline(gate, resources.deadline, cancellation.signal).catch(error => { if (!disposing) throw error })
        if (disposing) await route.abort("aborted")
        else await route.continue()
      } else if (action === "offline") await route.abort("internetdisconnected")
      else if (action === "404") await route.fulfill({ status: 404, contentType: "text/plain", body: "owned partial-precache fault" })
      else {
        const remaining = resources.deadline - Date.now()
        if (remaining <= 0) throw new Error("SW fault base fetch exceeded its original deadline")
        const actual = await withinQaDeadline(route.fetch({ maxRedirects: 0, timeout: remaining }), resources.deadline, cancellation.signal)
        const body = await withinQaDeadline(actual.body(), resources.deadline, cancellation.signal)
        assertFaultBase(asset, actual.status(), actual.headers(), body)
        record.originalStatus = actual.status()
        record.originalSha256 = createHash("sha256").update(body).digest("hex")
        const headers = { ...actual.headers(), ...(action === "mime" ? { "content-type": "text/html" } : { "cache-control": action === "private" ? "private, max-age=60" : "no-store" }) }
        await withinQaDeadline(route.fulfill({ response: actual, headers }), resources.deadline, cancellation.signal)
      }
      record.completed = true
    })().catch(async error => {
      try { await route.abort("aborted") } catch (abortError) { if (!disposing) failures.push(abortError) }
      throw error
    })
    tasks.add(task)
    void task.catch(error => { failures.push(error) }).finally(() => tasks.delete(task))
    return task
  }
  const owner = resources.own({}, async () => {
    disposing = true
    cancellation.abort()
    releaseHold!()
    const cleanupErrors: unknown[] = []
    try { if (acquisition.pending) await withinQaDeadline(acquisition.pending, resources.deadline) } catch (error) { cleanupErrors.push(error) }
    try { await withinQaDeadline(context.unroute(url, handler), resources.deadline) } catch (error) { cleanupErrors.push(error) }
    const results = await Promise.allSettled([...tasks])
    for (const result of results) if (result.status === "rejected" && !failures.includes(result.reason)) cleanupErrors.push(result.reason)
    if (failures.length || cleanupErrors.length) throw new AggregateError([...failures, ...cleanupErrors], "Owned SW fault cleanup failed")
  })
  acquisition.pending = context.route(url, handler).then(async () => { if (disposing) await context.unroute(url, handler) })
  await withinQaDeadline(acquisition.pending, resources.deadline)
  if (disposing) { await context.unroute(url, handler); throw new Error("SW fault registration completed after its owner retired") }
  return { records, held: () => held !== undefined, release: () => releaseHold!(), close: owner.close }
}

async function ownCdpAcquisition(resources: CaseResources, acquire: () => Promise<CDPSession>) {
  const state = { retired: false, session: undefined as CDPSession | undefined, pending: undefined as Promise<CDPSession> | undefined }
  const owner = resources.own(state, async state => {
    state.retired = true
    if (state.session) await withinQaDeadline(state.session.detach(), resources.deadline)
    else if (state.pending) await withinQaDeadline(state.pending.then(() => {}), resources.deadline)
  })
  state.pending = acquire().then(async session => {
    state.session = session
    if (state.retired) { await session.detach(); throw new Error("CDP acquisition completed after owner retirement") }
    return session
  })
  return { session: await withinQaDeadline(state.pending, resources.deadline), close: owner.close }
}

export async function ownedCdp(resources: CaseResources, context: BrowserContext, page: Page) {
  return ownCdpAcquisition(resources, () => context.newCDPSession(page))
}

export async function runQaScope<T>(work: (onClose: (close: () => Promise<void>) => void) => Promise<T>): Promise<T> {
  const closers: Array<() => Promise<void>> = [], errors: unknown[] = []
  let value: T | undefined
  try { value = await work(close => closers.push(close)) } catch (error) { errors.push(error) }
  for (const close of closers.reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "QA operation and owned cleanup failed")
  return value as T
}

export async function executingWorkerIdentity(page: Page, resources: CaseResources, testInfo: TestInfo, status: "activated" | "installed") {
  return runQaScope(async onClose => {
  const browser = page.context().browser()
  if (!browser || browser.browserType().name() !== "chromium") return blocked(testInfo, "Executing worker identity requires the owned Chromium")
  const rootCdp = await ownCdpAcquisition(resources, () => browser.newBrowserCDPSession())
  onClose(rootCdp.close)
  const root = rootCdp.session
  const pageCdp = await ownedCdp(resources, page.context(), page)
  onClose(pageCdp.close)
  const versions = new Map<string, { versionId: string; registrationId: string; scriptURL: string; targetId?: string; status: string; runningStatus: string }>()
  const registrations = new Map<string, { registrationId: string; scopeURL: string; isDeleted: boolean }>()
  pageCdp.session.on("ServiceWorker.workerVersionUpdated", event => { for (const version of event.versions) versions.set(version.versionId, version) })
  pageCdp.session.on("ServiceWorker.workerRegistrationUpdated", event => { for (const registration of event.registrations) registrations.set(registration.registrationId, registration) })
    const pageTarget = (await withinQaDeadline(pageCdp.session.send("Target.getTargetInfo"), resources.deadline)).targetInfo
    await withinQaDeadline(pageCdp.session.send("ServiceWorker.enable"), resources.deadline)
    const scriptURL = new URL("/sw.js", page.url()).href
    const scopeURL = new URL("/", page.url()).href
    const matches = () => [...versions.values()].filter(value => value.scriptURL === scriptURL && value.status === status && value.runningStatus === "running" && value.targetId
      && registrations.get(value.registrationId)?.scopeURL === scopeURL && !registrations.get(value.registrationId)?.isDeleted)
    await expect.poll(() => matches().length).toBe(1).catch(() => blocked(testInfo, "The installed protocol cannot identify one running owned version"))
    const targets = (await withinQaDeadline(root.send("Target.getTargets"), resources.deadline)).targetInfos
    const choices = matches().filter(value => targets.some(target => target.targetId === value.targetId && target.type === "service_worker" && target.url === scriptURL && target.browserContextId === pageTarget.browserContextId))
    const unique = [...new Map(choices.map(value => [value.versionId, value])).values()]
    if (unique.length !== 1) return blocked(testInfo, "Active/waiting version does not map to exactly one running owned target")
    const version = unique[0]!
    const attached = { retired: false, pending: undefined as Promise<{ sessionId: string }> | undefined }
    const targetOwner = resources.own(attached, async state => {
      state.retired = true
      if (state.pending) {
        const target = await withinQaDeadline(state.pending, resources.deadline)
        await withinQaDeadline(root.send("Target.detachFromTarget", { sessionId: target.sessionId }), resources.deadline)
      }
    })
    onClose(targetOwner.close)
    attached.pending = root.send("Target.attachToTarget", { targetId: version.targetId!, flatten: false }).then(async target => {
      if (attached.retired) { await root.send("Target.detachFromTarget", { sessionId: target.sessionId }); throw new Error("Worker CDP attachment completed after retirement") }
      return target
    })
    const { sessionId } = await withinQaDeadline(attached.pending, resources.deadline)
    let nextId = 0
    const parsed: Array<{ scriptId: string; url: string }> = []
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
    const received = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return
      const message = JSON.parse(event.message) as { id?: number; method?: string; params?: { scriptId: string; url: string }; result?: Record<string, unknown>; error?: { message: string } }
      if (message.method === "Debugger.scriptParsed" && message.params) parsed.push(message.params)
      if (message.id !== undefined) {
        const operation = pending.get(message.id)
        if (operation) { pending.delete(message.id); if (message.error) operation.reject(new Error(message.error.message)); else operation.resolve(message.result ?? {}) }
      }
    }
    root.on("Target.receivedMessageFromTarget", received)
    const commands = resources.own(pending, async entries => {
      root.off("Target.receivedMessageFromTarget", received)
      for (const operation of entries.values()) operation.reject(new Error("Read-only worker identity session closed"))
      entries.clear()
    })
    onClose(commands.close)
    const send = async (method: string, params = {}) => {
      const id = ++nextId
      const result = new Promise<Record<string, unknown>>((resolve, reject) => pending.set(id, { resolve, reject }))
      const response = withinQaDeadline(result, resources.deadline)
      void response.catch(() => {})
      try {
        await withinQaDeadline(root.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }), resources.deadline)
        return await response
      } catch (error) {
        pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)))
        await response.catch(() => {})
        throw error
      } finally { pending.delete(id) }
    }
      await send("Debugger.enable")
      await expect.poll(() => parsed.filter(value => value.url === scriptURL).length).toBe(1)
      const source = await send("Debugger.getScriptSource", { scriptId: parsed.find(value => value.url === scriptURL)!.scriptId })
      if (typeof source.scriptSource !== "string") return blocked(testInfo, "Owned target did not supply its parsed source")
      const target = (await withinQaDeadline(root.send("Target.getTargetInfo", { targetId: version.targetId! }), resources.deadline)).targetInfo
      const current = versions.get(version.versionId)
      const registration = registrations.get(version.registrationId)
      if (!current || current.status !== status || current.runningStatus !== "running" || current.targetId !== version.targetId || current.registrationId !== version.registrationId
        || registration?.scopeURL !== scopeURL || registration.isDeleted || target.type !== "service_worker" || target.url !== scriptURL || target.browserContextId !== pageTarget.browserContextId) blocked(testInfo, "Worker identity changed while its parsed source was read")
      return { ...version, browserContextId: pageTarget.browserContextId, bytes: Buffer.byteLength(source.scriptSource), sha256: createHash("sha256").update(source.scriptSource).digest("hex") }
  })
}

export function actualRuntimeAsset(release: ReleaseName, kind: "code" | "fonts" | "images", exclude: string[] = []) {
  const asset = releaseAssets(release).find(value => value.zone === "blog" && publicRuntimeAssetKind(value.url) === kind && !exclude.includes(value.url))
  if (!asset) throw new Error(`Bound release has no actual ${kind} asset`)
  return asset
}

export function releaseDelta(from: QaAsset[], to: QaAsset[]) {
  const old = new Map(from.filter(asset => asset.precache).map(asset => [asset.url, asset]))
  const next = new Map(to.filter(asset => asset.precache).map(asset => [asset.url, asset]))
  return {
    added: [...next.keys()].filter(url => !old.has(url)).sort(),
    deleted: [...old.keys()].filter(url => !next.has(url)).sort(),
    changed: [...next.keys()].filter(url => old.has(url) && old.get(url)!.sha256 !== next.get(url)!.sha256).sort(),
    unchanged: [...next.keys()].filter(url => old.has(url) && old.get(url)!.sha256 === next.get(url)!.sha256).sort(),
  }
}

export async function expectNativeBody(page: Page, cacheName: string, resource: NativeResource) {
  await expect.poll(async () => (await publicNativeSnapshot(page, [cacheName])).caches[cacheName]?.find(value => value.url === resource.url)).toMatchObject({ url: resource.url, bytes: resource.bytes, sha256: resource.sha256 })
}

export async function warmBoundAsset(page: Page, asset: QaAsset) {
  const resource = await readNativeResource(page, asset.url)
  expect(resource.fromServiceWorker).toBe(true)
  expect(resource).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256 })
  const kind = publicRuntimeAssetKind(asset.url)
  if (kind) await expectNativeBody(page, runtimeName(kind), resource)
  return resource
}

export async function ownedOffline(resources: CaseResources, context: BrowserContext, work: () => Promise<void>) {
  const owner = resources.own({}, async () => { await context.setOffline(false) })
  await runQaScope(async onClose => {
    onClose(owner.close)
    await context.setOffline(true)
    await work()
  })
}

export function qaDeadlineSignal(resources: CaseResources) {
  const remaining = resources.deadline - Date.now()
  if (remaining <= 0) throw new Error("QA HTTP operation exceeded its original case deadline")
  return AbortSignal.timeout(remaining)
}

export async function qaApi<T>(actors: CaseActors, resources: CaseResources, role: "alice" | "bob", path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const observation = forensicRecords.get(resources)
  const request = observation?.start(init?.method ?? "GET", path)
  let response: Response
  try {
    response = await fetch(`${WEB_URL}${path}`, { ...init, signal: qaDeadlineSignal(resources), headers: { Cookie: actors.sessionCookie(role), Origin: WEB_URL, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } })
  } catch (error) {
    if (request !== undefined) observation!.failed(request)
    throw error
  }
  if (request !== undefined) observation!.response(request, response)
  if (!response.ok) throw new Error(`QA ${init?.method ?? "GET"} ${path} returned ${response.status}`)
  return { status: response.status, body: await response.json() as T }
}

export async function ownedBusiness(actors: CaseActors, role: "alice" | "bob", resources: CaseResources) {
  const serverId = await actors.seed.seedServer(role, `public-static-${role}-${Date.now()}`)
  const channelId = await actors.seed.seedChannel(role, serverId, "native-cache-qa")
  const { page, context } = await actors.asUser(role)
  const proxy = await proxyCommunityWebSockets(context)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const write = async (text: string) => {
    const offset = proxy.frames.length
    const result = await qaApi<{ message: { id: string; seq: number; content: string } }>(actors, resources, role, `/api/community/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content: text }) })
    expect(result.status).toBe(201)
    expect(result.body.message.seq).toBeGreaterThan(0)
    await expect.poll(() => proxy.frames.slice(offset).flatMap(communityFrameEvents).some(event => event.type === "community:message.create" && (event.messageId === result.body.message.id || event.message?.id === result.body.message.id))).toBe(true)
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible()
    return { ...result.body.message, status: result.status }
  }
  const read = async (id: string) => {
    const result = await qaApi<{ messages: Array<{ id: string; seq: number; content: string }> }>(actors, resources, role, `/api/community/channels/${channelId}/messages`)
    const message = result.body.messages.find(value => value.id === id)
    expect(message).toBeTruthy()
    return message!
  }
  return { page, context, proxy, serverId, channelId, write, read, close: () => resources.closeContext(context) }
}

export async function ownD1WsProbe(actors: CaseActors, resources: CaseResources, testInfo: TestInfo) {
  const observation = forensicRecords.get(resources)
  const hostname = `qa222-${createHash("sha256").update(testInfo.testId).digest("hex").slice(0, 20)}`
  const state = { machineId: "", pairingRequested: false, tokenId: "", tokenConsumed: false, activationOutcome: "not_attempted", activationPending: undefined as Promise<void> | undefined, socket: undefined as WebSocket | undefined, closed: undefined as Promise<void> | undefined, opened: 0, closes: 0, frames: [] as Array<{ type: string }> }
  const owner = resources.own(state, async state => {
    observation?.phase("cleanup")
    observation?.event("cleanup-start")
    const errors: unknown[] = []
    await state.activationPending?.catch(error => errors.push(error))
    if (state.pairingRequested && !state.tokenConsumed) errors.push(new Error(`Pairing token consumption remains UNKNOWN (${state.activationOutcome}); no public revocation proof is available`))
    try {
      if (state.socket && state.socket.readyState !== WebSocket.CLOSED) {
        if (state.socket.readyState === WebSocket.CONNECTING) state.socket.close()
        else state.socket.close(1000, "case owner cleanup")
        await withinQaDeadline(state.closed!, resources.deadline)
      }
    } catch (error) { errors.push(error) }
    try {
      const machines = await qaApi<{ machines: Array<{ id: string; hostname: string }> }>(actors, resources, "alice", "/api/community/machines")
      const ids = new Set([state.machineId, ...machines.body.machines.filter(value => value.hostname.startsWith(hostname)).map(value => value.id)].filter(Boolean))
      for (const id of ids) {
        const deleted = await fetch(`${WEB_URL}/api/community/machines/${id}`, { method: "DELETE", signal: qaDeadlineSignal(resources), headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL } })
        expect(deleted.status).toBe(204)
      }
      expect((await qaApi<{ machines: Array<{ id: string; hostname: string }> }>(actors, resources, "alice", "/api/community/machines")).body.machines.some(value => ids.has(value.id) || value.hostname.startsWith(hostname))).toBe(false)
    } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "D1/WS capability resource retirement failed")
  })
  state.activationPending = (async () => {
    state.pairingRequested = true
    const pair = await qaApi<{ tokenId: string }>(actors, resources, "alice", "/api/community/machines/pair", { method: "POST" })
    state.tokenId = pair.body.tokenId
    if (!state.tokenId) throw new Error("Pairing response did not identify its issued token")
    state.activationOutcome = "unknown"
    const activationRequest = observation?.start("POST", "/api/community/daemon/activate")
    const response = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
      method: "POST", signal: qaDeadlineSignal(resources), headers: { Authorization: `Bearer ${state.tokenId}`, Origin: WEB_URL, "content-type": "application/json" },
      body: JSON.stringify({ hostname, platform: "linux", arch: "x64", osRelease: "qa", daemonVersion: "0.1.53", runtimeReport: [] }),
    })
    if (activationRequest !== undefined) observation!.response(activationRequest, response)
    expect(response.status).toBe(200)
    const activation = await response.json() as { machineId: string; credential: string; sessionOutcome: string }
    state.machineId = activation.machineId
    state.activationOutcome = activation.sessionOutcome
    expect(activation.sessionOutcome).toBe("committed")
    expect(activation.machineId).toBeTruthy()
    expect(activation.credential).toBeTruthy()
    state.tokenConsumed = true
    observation?.event("activation-committed")
    const NativeSocket = globalThis.WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket
    state.socket = new NativeSocket(MACHINE_WS_URL.replace(/^http/, "ws"), { headers: { Authorization: `Bearer ${activation.credential}`, Origin: WEB_URL } })
    state.closed = new Promise(resolveClose => state.socket!.addEventListener("close", () => { state.closes++; observation?.event("ws-close"); resolveClose() }, { once: true }))
    state.socket.addEventListener("message", event => {
      const frame = JSON.parse(String(event.data)) as { type: string; nonce?: string }
      state.frames.push({ type: frame.type })
      observation?.frame(frame.type)
      if (frame.type === "machine:heartbeat") state.socket!.send(JSON.stringify({ type: "machine_heartbeat_ack", nonce: frame.nonce }))
    })
    await withinQaDeadline(new Promise<void>((resolveOpen, reject) => {
      state.socket!.addEventListener("open", () => { state.opened++; observation?.event("ws-open"); resolveOpen() }, { once: true })
      state.socket!.addEventListener("error", () => reject(new Error("Real same-origin machine WS failed")), { once: true })
      state.socket!.addEventListener("close", () => reject(new Error("Real same-origin machine WS closed before ready")), { once: true })
    }), resources.deadline)
  })()
  await state.activationPending
  const writeAndRead = async (phase: string) => {
    observation?.phase(phase)
    const socket = state.socket!
    const observedFrom = Date.now()
    expect(state.socket!.readyState).toBe(WebSocket.OPEN)
    expect(state.opened).toBe(1)
    expect(state.closes).toBe(0)
    const changedHostname = `${hostname}-${phase}`
    observation?.event("ready-send-before")
    state.socket!.send(JSON.stringify({ type: "ready", runtimeReport: [], runningAgents: [], capabilities: ["control-heartbeat-v1"], hostname: changedHostname, platform: "linux", arch: "x64", osRelease: "qa", daemonVersion: "0.1.53" }))
    observation?.event("ready-send-returned")
    await expect.poll(async () => (await qaApi<{ machines: Array<{ id: string; hostname: string; status: string }> }>(actors, resources, "alice", "/api/community/machines")).body.machines.find(value => value.id === state.machineId)).toMatchObject({ id: state.machineId, hostname: changedHostname, status: "online" })
    expect(state.socket).toBe(socket)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(state.opened).toBe(1)
    expect(state.closes).toBe(0)
    return { machineId: state.machineId, hostname: changedHostname, observedFrom, observedThrough: Date.now(), sameSocketInstance: true, opened: state.opened, closes: state.closes, frameTypes: state.frames.map(value => value.type), nodeVersion: process.versions.node }
  }
  return { writeAndRead, close: owner.close }
}

export function observeCandidate(context: BrowserContext, resources: CaseResources) {
  const existing = new Set(context.serviceWorkers())
  let resolveWorker: (worker: Worker) => void = () => {}
  const promise = new Promise<Worker>(resolve => { resolveWorker = resolve })
  const listener = (worker: Worker) => { if (!existing.has(worker) && new URL(worker.url()).pathname === "/sw.js") resolveWorker(worker) }
  const owner = resources.own({}, async () => { context.off("serviceworker", listener) })
  context.on("serviceworker", listener)
  return { promise, close: owner.close }
}

export async function updateRoot(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/")
    if (!registration?.active) throw new Error("Real update requires an existing active root registration")
    const states: string[] = []
    const found = () => {
      const worker = registration.installing
      if (!worker) return
      states.push(worker.state)
      worker.addEventListener("statechange", () => states.push(worker.state))
    }
    registration.addEventListener("updatefound", found, { once: true })
    const state = window as unknown as { __qa222WorkerStates?: string[] }
    state.__qa222WorkerStates = states
    try { await registration.update(); return { update: "resolved" } }
    catch (error) { return { update: "rejected", error: String(error) } }
  })
}

export async function rootStates(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/")
    return { active: registration?.active?.state, waiting: registration?.waiting?.state, installing: registration?.installing?.state, observed: (window as unknown as { __qa222WorkerStates?: string[] }).__qa222WorkerStates ?? [] }
  })
}

export async function expectReleasePrecache(page: Page, release: ReleaseName) {
  const expected = releaseAssets(release).filter(asset => asset.precache)
  if (!expected.length) throw new Error("Bound release has no complete precache catalogue")
  const snapshot = await publicNativeSnapshot(page)
  const actual = Object.entries(snapshot.caches).filter(([name]) => name.startsWith("alook-public-precache-")).flatMap(([, entries]) => entries)
  expect(actual.map(entry => new URL(entry.url).pathname).sort()).toEqual(expected.map(asset => asset.url).sort())
  for (const asset of expected) {
    const entry = actual.find(entry => new URL(entry.url).pathname === asset.url)!
    expect(entry).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256 })
    const key = new URL(entry.url)
    expect(key.origin).toBe(new URL(page.url()).origin)
    expect([...key.searchParams.values()]).toEqual(asset.revision === null ? [] : [asset.revision])
  }
  return snapshot
}

export async function activateAfterClientExit(context: BrowserContext, resources: CaseResources, pages: Page[], versionId: string, testInfo: TestInfo) {
  const scopeURL = new URL("/", pages[0]!.url()).href
  const page = await context.newPage()
  await runQaScope(async onClose => {
    const cdp = await ownedCdp(resources, context, page)
    onClose(cdp.close)
    const versions = new Map<string, { versionId: string; registrationId: string; status: string }>()
    const scopes = new Map<string, string>()
    cdp.session.on("ServiceWorker.workerRegistrationUpdated", event => { for (const value of event.registrations) if (!value.isDeleted) scopes.set(value.registrationId, value.scopeURL) })
    cdp.session.on("ServiceWorker.workerVersionUpdated", event => { for (const value of event.versions) versions.set(value.versionId, value) })
    await withinQaDeadline(cdp.session.send("ServiceWorker.enable"), resources.deadline)
    await expect.poll(() => {
      const candidate = versions.get(versionId)
      return candidate && scopes.get(candidate.registrationId) === scopeURL ? candidate.status : null
    }).toBe("installed").catch(() => blocked(testInfo, "The uncontrolled owned page cannot observe the exact waiting version"))
    expect(page.url()).toBe("about:blank")
    for (const old of pages) await old.close()
    await expect.poll(() => versions.get(versionId)?.status).toBe("activated").catch(() => blocked(testInfo, "Exact waiting version did not naturally activate after its controlled clients closed"))
  })
  await page.goto("/robots.txt")
  await rootWorker(page)
  return page
}

export async function attachQa(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" })
}

export async function seedNativeOverflow(page: Page, kind: "code" | "fonts", count: number, realUrl: string) {
  const cacheName = runtimeName(kind)
  return page.evaluate(async ({ kind, count, cacheName, realUrl }) => {
    const cache = await caches.open(cacheName)
    const template = await cache.match(new URL(realUrl, location.href).href)
    if (!template) throw new Error("Overflow preparation requires a real worker-created body")
    const bytes = await template.arrayBuffer()
    const base = Date.now() - 60_000
    const entries = Array.from({ length: count }, (_, index) => ({ url: new URL(`/blog-static/_next/static/${kind === "code" ? "chunks" : "media"}/qa222-overflow-${String(index).padStart(3, "0")}.${kind === "code" ? "js" : "woff2"}`, location.href).href, timestamp: base + index }))
    for (const entry of entries) await cache.put(entry.url, new Response(bytes.slice(0), { headers: template.headers }))
    await new Promise<void>((resolveWrite, reject) => {
      const request = indexedDB.open("serwist-expiration")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("cache-entries", "readwrite"), store = tx.objectStore("cache-entries")
        const real = store.get(`${cacheName}|${new URL(realUrl, location.href).href}`)
        real.onsuccess = () => {
          if (!real.result || real.result.cacheName !== cacheName) { tx.abort(); return }
          for (const entry of entries) store.put({ id: `${cacheName}|${entry.url}`, cacheName, ...entry })
        }
        tx.oncomplete = () => { db.close(); resolveWrite() }
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Native overflow metadata template is absent")) }
      }
    })
    return { preparation: "artificial native overflow, not distinct real downloads", cacheName, entries }
  }, { kind, count, cacheName, realUrl })
}

export async function prepareUnrelatedNativeState(page: Page, caseId: string) {
  const sentinel = `qa:222:${createHash("sha256").update(caseId).digest("hex").slice(0, 20)}`
  await page.evaluate(async sentinel => {
    for (const [name, storeName] of [["keyval-store", "keyval"], [sentinel, "sentinel"]]) {
      await new Promise<void>((resolveWrite, reject) => {
        const request = indexedDB.open(name)
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName) }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(storeName, "readwrite")
          tx.objectStore(storeName).put({ sentinel, intact: true }, sentinel)
          tx.oncomplete = () => { db.close(); resolveWrite() }
          tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
        }
      })
    }
    await new Promise<void>((resolveWrite, reject) => {
      const request = indexedDB.open("serwist-expiration")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("cache-entries", "readwrite")
        const url = new URL(`/${sentinel}`, location.href).href
        tx.objectStore("cache-entries").put({ id: `${sentinel}|${url}`, cacheName: sentinel, url, timestamp: 222 })
        tx.oncomplete = () => { db.close(); resolveWrite() }
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
      }
    })
  }, sentinel)
  return sentinel
}

export async function expectUnrelatedNativeState(page: Page, sentinel: string) {
  const records = await page.evaluate(async sentinel => {
    const values = []
    for (const [name, storeName] of [["keyval-store", "keyval"], [sentinel, "sentinel"]]) {
      values.push(await new Promise<unknown>((resolveRead, reject) => {
        const request = indexedDB.open(name)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(storeName, "readonly"), read = tx.objectStore(storeName).get(sentinel)
          tx.oncomplete = () => { db.close(); resolveRead(read.result) }
          tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
        }
      }))
    }
    return values
  }, sentinel)
  expect(records).toEqual([{ sentinel, intact: true }, { sentinel, intact: true }])
  const rows = (await publicNativeSnapshot(page)).expiration.filter(row => row.cacheName === sentinel)
  expect(rows).toEqual([{ id: `${sentinel}|${new URL(`/${sentinel}`, page.url()).href}`, cacheName: sentinel, url: new URL(`/${sentinel}`, page.url()).href, timestamp: 222 }])
}

export async function seedOldPublicNamespace(page: Page, realUrl: string) {
  const sourceCache = runtimeName("code")
  return page.evaluate(async ({ realUrl, sourceCache }) => {
    const url = new URL(realUrl, location.href).href
    const response = await (await caches.open(sourceCache)).match(url)
    if (!response) throw new Error("Old-namespace fixture requires a real captured current public body")
    const names = ["alook-public-v0-blog-code", "alook-public-precache-v0"]
    for (const name of names) await (await caches.open(name)).put(url, response.clone())
    await new Promise<void>((resolveWrite, reject) => {
      const request = indexedDB.open("serwist-expiration")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("cache-entries", "readwrite"), cacheName = names[0]!
        tx.objectStore("cache-entries").put({ id: `${cacheName}|${url}`, cacheName, url, timestamp: Date.now() })
        tx.oncomplete = () => { db.close(); resolveWrite() }
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
      }
    })
    return { preparation: "artificial discoverable old public namespaces using a captured real current body; not historical residue evidence", names, url }
  }, { realUrl, sourceCache })
}

export type DeviceSnapshot = { epoch: string; records: Array<{ key: string; encoded: string }>; payloadKeys: string[] }

export async function deviceSnapshot(page: Page): Promise<DeviceSnapshot> {
  return page.evaluate(async () => new Promise<{ epoch: string; records: Array<{ key: string; encoded: string }>; payloadKeys: string[] }>((resolveRead, reject) => {
    const request = indexedDB.open("keyval-store")
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("keyval", "readonly"), store = tx.objectStore("keyval")
      const keys = store.getAllKeys(), values = store.getAll()
      tx.oncomplete = () => {
        const records = keys.result.map((key, index) => ({ key: String(key), encoded: JSON.stringify(values.result[index], (_, value) => value instanceof Map ? { nativeMap: [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))) } : value) })).sort((a, b) => a.key.localeCompare(b.key))
        const epoch = values.result[keys.result.indexOf("alook:qc:device-epoch")]
        db.close()
        resolveRead({ epoch, records, payloadKeys: records.filter(record => /^alook:qc:[^:]+:[^:]+(?::application)?:client$/.test(record.key)).map(record => record.key) })
      }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }))
}

export function preservedDeviceMetadata(snapshot: DeviceSnapshot) {
  return snapshot.records.filter(record => record.key !== "alook:qc:device-epoch" && !snapshot.payloadKeys.includes(record.key))
}

export async function insertArtificialRetiredResidual(page: Page, userId: string, captured: DeviceSnapshot) {
  const key = `alook:qc:cache:${userId}:client`
  const record = captured.records.find(record => record.key === key)
  if (!record) throw new Error("Retired residual requires a captured real account payload")
  const payload = JSON.parse(record.encoded) as unknown
  if (typeof payload !== "string") throw new Error("Captured native community payload is not its real JSON string")
  const envelope = JSON.parse(payload) as { version: number; buster: string; clientState: unknown; channelFences: unknown[] }
  if (envelope.version !== 6 || envelope.buster !== "6" || !envelope.clientState || !Array.isArray(envelope.channelFences)) throw new Error("Captured real persistence envelope is not the forwarded version 6 contract")
  const keys = [key, `alook:qc:cache:${userId}:application:client`, `alook:qc:legacy:${userId}:client`]
  const channelFixture = { channelId: crypto.randomUUID(), epoch: crypto.randomUUID(), deleted: true }
  await page.evaluate(async ({ keys, payload, userId, channelFixture }) => new Promise<void>((resolveWrite, reject) => {
    const request = indexedDB.open("keyval-store")
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("keyval", "readwrite"), store = tx.objectStore("keyval")
      const fenceKey = `alook:qc:cache:${userId}:account-epoch:channels`, read = store.get(fenceKey)
      read.onsuccess = () => {
        if (!(read.result instanceof Map)) { tx.abort(); return }
        const map = read.result as Map<string, { epoch: string; deleted: boolean }>
        map.set(channelFixture.channelId, { epoch: channelFixture.epoch, deleted: true })
        store.put(map, fenceKey)
        for (const key of keys) store.put(payload, key)
      }
      tx.oncomplete = () => { db.close(); resolveWrite() }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }), { keys, payload, userId, channelFixture })
  return { preparation: "artificial retired account residual and native Map tombstone for an unused fixture channel UUID; compatibility keys copy captured community bytes only for physical deletion", keys, channelFixture, bytes: Buffer.byteLength(payload), sha256: createHash("sha256").update(payload).digest("hex") }
}

export async function observeDeviceClear(page: Page, resources: CaseResources, previousEpoch: string) {
  if (typeof previousEpoch !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(previousEpoch)) throw new Error("Device Clear requires a captured native UUID epoch")
  const owner = resources.own({}, async () => {
    if (!page.isClosed()) await page.evaluate(() => { (window as unknown as { __qa222Clear?: { cancel(): void } }).__qa222Clear?.cancel() })
  })
  await page.evaluate(({ previousEpoch, deadline }) => {
    const state = window as unknown as { __qa222Clear?: { cancel(): void; result: Promise<{ epoch: string; records: Array<{ key: string; encoded: string }>; payloadKeys: string[] }> } }
    if (state.__qa222Clear) throw new Error("Device-clear observer already exists")
    let db: IDBDatabase | undefined, retired = false
    const timerState = { value: undefined as ReturnType<typeof setTimeout> | undefined }
    let rejectResult: (error: Error) => void = () => {}
    const result = new Promise<{ epoch: string; records: Array<{ key: string; encoded: string }>; payloadKeys: string[] }>((resolveRead, reject) => {
      rejectResult = reject
      const request = indexedDB.open("keyval-store")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        db = request.result
        if (retired) { db.close(); return }
        const probe = () => {
          if (retired) return
          const tx = db!.transaction("keyval", "readonly"), store = tx.objectStore("keyval"), keys = store.getAllKeys(), values = store.getAll()
          tx.onabort = tx.onerror = () => { retired = true; clearTimeout(timerState.value); db!.close(); reject(tx.error) }
          tx.oncomplete = () => {
            const epoch = values.result[keys.result.indexOf("alook:qc:device-epoch")]
            if (epoch === previousEpoch) { probe(); return }
            const records = keys.result.map((key, index) => ({ key: String(key), encoded: JSON.stringify(values.result[index], (_, value) => value instanceof Map ? { nativeMap: [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))) } : value) })).sort((a, b) => a.key.localeCompare(b.key))
            retired = true
            clearTimeout(timerState.value)
            db!.close()
            resolveRead({ epoch, records, payloadKeys: records.filter(record => /^alook:qc:[^:]+:[^:]+(?::application)?:client$/.test(record.key)).map(record => record.key) })
          }
        }
        probe()
      }
    })
    void result.catch(() => {})
    const cancel = () => { retired = true; clearTimeout(timerState.value); db?.close(); rejectResult(new Error("Owned device-clear observer retired")) }
    timerState.value = setTimeout(cancel, Math.max(1, deadline - Date.now()))
    state.__qa222Clear = { result, cancel }
  }, { previousEpoch, deadline: resources.deadline })
  return { result: () => page.evaluate(() => (window as unknown as { __qa222Clear: { result: Promise<DeviceSnapshot> } }).__qa222Clear.result), close: owner.close }
}

export async function clearThroughSettings(page: Page) {
  return runQaScope(async onClose => {
  await page.getByTestId(tid.userSettingsOpen).click()
  await page.getByTestId(tid.settingsTab("advanced")).click()
  const sizeBefore = await page.getByTestId(tid.settingsCacheSize).innerText()
  const dialogs: string[] = []
  const dismissals: Promise<void>[] = []
  const accept = (dialog: import("@playwright/test").Dialog) => {
    dialogs.push(dialog.message())
    const pending = Promise.resolve().then(() => dialog.dismiss())
    dismissals.push(pending)
    void pending.catch(() => {})
  }
  page.on("dialog", accept)
  onClose(async () => {
    page.off("dialog", accept)
    const results = await Promise.allSettled(dismissals)
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, "Settings error-dialog dismissal failed")
  })
    await page.getByRole("button", { name: "Clear local cache", exact: true }).click()
    const dialog = page.getByRole("dialog").or(page.getByRole("alertdialog")).filter({ hasText: "Clear local cache?" })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Clear cache", exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(dialogs).toEqual([])
    await expect(page.getByRole("alert").filter({ hasText: /(?:failed|error|could not)/i })).toHaveCount(0)
    const sizeAfter = await page.getByTestId(tid.settingsCacheSize).innerText()
    expect(sizeAfter.trim().length).toBeGreaterThan(0)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(tid.settingsTab("advanced"))).toBeHidden()
    return { sizeBefore, sizeAfter, errorDialogs: dialogs }
  })
}
