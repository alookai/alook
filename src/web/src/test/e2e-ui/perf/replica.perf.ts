/**
 * Black-box Alook Replica benchmark. This deliberately imports no Replica
 * runtime code: browser-visible state, generic durable browser storage, HTTP
 * authority, and the request trace are the only evidence sources.
 */
import {
  test,
  expect,
  chromium,
  type APIRequestContext,
  type BrowserContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { DEV_PASSWORD } from "@alook/shared"
import { composerEditable } from "../_fixtures/actions"
import { tid } from "../_fixtures/testids"
import {
  analyzeReplicaBenchmark,
  renderReplicaBenchmarkReport,
} from "../../../../scripts/replica-benchmark-report"
import {
  emptySample,
  ReplicaArtifactWriter,
  ReplicaNetworkProbe,
} from "./replica-benchmark-fixture"
import {
  REPLICA_BENCHMARK_SCHEMA_VERSION,
  REPLICA_BENCHMARK_SERVER_MODE,
  type ReplicaBenchmarkArtifact,
  type ReplicaBenchmarkMode,
  type ReplicaBenchmarkSample,
  type ReplicaBenchmarkServerMode,
  type ReplicaProof,
  type ReplicaScenarioId,
} from "./replica-benchmark-types"

const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"
const ARTIFACTS_DIR = resolve(__dirname, "..", "..", "..", "..", "perf-artifacts")
const MANIFEST_PATH = resolve(ARTIFACTS_DIR, "seed-manifest.json")
const MODE = (process.env.REPLICA_BENCH_MODE ?? "baseline") as ReplicaBenchmarkMode
const SELECTED_SCENARIOS: ReplicaScenarioId[] = [
  "j1-covered-reopen",
  "j2-covered-navigation",
  "j5-draft",
  "j6-text-send",
]
const CONTRACT_VERSION = [
  "oracle:4d1533d443adbeb583f29bd6c5bd997079b81a08277b687165b0b61f54ee7b6b",
  "wire:ea168934b360d45159446cefd13e09c0bd4d1d6dce6d3a567012b8c6ca43e29e",
  "server-contract:d8659d58465bf57a0f5d7cb9d0819092c3ac0cce",
  "harness-protocol:v3",
].join("+")

interface SeedManifest {
  owner: { email: string; userId: string }
  servers: Array<{
    id: string
    name: string
    channels: Array<{ id: string; name: string; messageCount: number }>
  }>
}

interface ApiMessage {
  id: string
  seq: number
  content: string | null
  clientNonce?: string | null
}

class ProductFailure extends Error {}

function proof(id: string, passed: boolean, evidence: string): ReplicaProof {
  return { id, passed, evidence }
}

function loadManifest(): { manifest: SeedManifest; fixtureVersion: string } {
  let raw: Buffer
  try {
    raw = readFileSync(MANIFEST_PATH)
  } catch {
    throw new Error(`Missing ${MANIFEST_PATH}. Run seed:stress before this benchmark.`)
  }
  return {
    manifest: JSON.parse(raw.toString("utf8")) as SeedManifest,
    fixtureVersion: `origin-reset-v1+seed-sha256:${createHash("sha256").update(raw).digest("hex")}`,
  }
}

/**
 * Mandatory anti-contamination preflight. It runs against an about:blank page,
 * before auth or the first product navigation can install a worker. Chromium's
 * `all` origin-storage wipe includes service workers, Cache Storage, and IDB.
 */
async function resetOriginBeforeBootstrap(context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? await context.newPage()
  const session = await context.newCDPSession(page)
  try {
    await session.send("Storage.clearDataForOrigin", {
      origin: new URL(BASE_URL).origin,
      storageTypes: "all",
    })
    await session.send("Network.enable")
    await session.send("Network.clearBrowserCache")
  } finally {
    await session.detach()
  }
}

async function authenticateAs(context: BrowserContext, email: string): Promise<void> {
  let response = await context.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
    data: { email, password: DEV_PASSWORD },
  })
  if (!response.ok()) {
    response = await context.request.post(`${BASE_URL}/api/auth/sign-up/email`, {
      data: { name: email.split("@")[0], email, password: DEV_PASSWORD },
    })
  }
  if (!response.ok()) throw new Error(`Could not authenticate ${email} (${response.status()})`)
}

async function apiMessages(api: APIRequestContext, channelId: string): Promise<ApiMessage[]> {
  const response = await api.get(`${BASE_URL}/api/community/channels/${channelId}/messages?limit=100`)
  if (!response.ok()) throw new Error(`messages authority returned ${response.status()}`)
  return ((await response.json()) as { messages: ApiMessage[] }).messages
}

async function apiReadState(api: APIRequestContext, channelId: string) {
  const response = await api.get(`${BASE_URL}/api/community/channels/${channelId}/read-state`)
  if (!response.ok()) throw new Error(`read-state authority returned ${response.status()}`)
  return await response.json() as { lastReadMessageId: string | null; lastReadSeq: number }
}

async function waitForReadThrough(
  api: APIRequestContext,
  channelId: string,
  targetSeq: number,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs
  let state = await apiReadState(api, channelId)
  while (state.lastReadSeq < targetSeq && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    state = await apiReadState(api, channelId)
  }
  return state
}

async function waitForCanonicalCount(
  api: APIRequestContext,
  channelId: string,
  marker: string,
  timeoutMs = 20_000,
): Promise<{ count: number; messages: ApiMessage[]; observedAtMs: number }> {
  const deadline = Date.now() + timeoutMs
  let messages: ApiMessage[] = []
  while (Date.now() < deadline) {
    messages = await apiMessages(api, channelId)
    const count = messages.filter((message) => message.content === marker).length
    if (count > 0) return { count, messages, observedAtMs: Date.now() }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  return { count: 0, messages, observedAtMs: Date.now() }
}

async function durableStorageContains(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(async (needle) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && `${key}:${localStorage.getItem(key) ?? ""}`.includes(needle)) return true
    }
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : []
    for (const database of databases) {
      if (!database.name) continue
      const found = await new Promise<boolean>((resolveFound) => {
        const open = indexedDB.open(database.name!)
        open.onerror = () => resolveFound(false)
        open.onsuccess = () => {
          const db = open.result
          const stores = Array.from(db.objectStoreNames)
          if (stores.length === 0) {
            db.close()
            resolveFound(false)
            return
          }
          const tx = db.transaction(stores, "readonly")
          let matched = false
          for (const storeName of stores) {
            const request = tx.objectStore(storeName).getAll()
            request.onsuccess = () => {
              try {
                if (JSON.stringify(request.result).includes(needle)) matched = true
              } catch {}
            }
          }
          tx.oncomplete = () => {
            db.close()
            resolveFound(matched)
          }
          tx.onerror = () => {
            db.close()
            resolveFound(false)
          }
        }
      })
      if (found) return true
    }
    return false
  }, marker)
}

async function waitForReplicaTailCoverage(page: Page, channelId: string, timeoutMs = 20_000) {
  await expect.poll(async () => page.evaluate(async (targetChannelId) => {
    let routePublished = false
    try {
      const control = JSON.parse(localStorage.getItem("alook-community-replica-control-v1:active") ?? "null") as {
        shellRoutes?: unknown
      } | null
      routePublished = Array.isArray(control?.shellRoutes) && control.shellRoutes.includes(location.pathname)
    } catch {
      routePublished = false
    }
    if (!routePublished) return false
    const shellCache = await caches.open("alook-community-shell-v1")
    if (!await shellCache.match(`${location.origin}${location.pathname}`)) return false
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : []
    for (const database of databases) {
      if (!database.name?.startsWith("alook-community-replica-v")) continue
      const covered = await new Promise<boolean>((resolveCovered) => {
        const open = indexedDB.open(database.name!)
        open.onerror = () => resolveCovered(false)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains("coverage")) {
            db.close()
            resolveCovered(false)
            return
          }
          const request = db.transaction("coverage", "readonly")
            .objectStore("coverage")
            .get(`channel:${targetChannelId}`)
          request.onerror = () => {
            db.close()
            resolveCovered(false)
          }
          request.onsuccess = () => {
            const value = request.result as {
              permission?: { validUntil?: string }
              completeness?: string
              messageRange?: { hasNewer?: boolean } | null
            } | undefined
            db.close()
            resolveCovered(Boolean(
              value
              && typeof value.permission?.validUntil === "string"
              && Date.parse(value.permission.validUntil) > Date.now()
              && (value.messageRange ? value.messageRange.hasNewer === false : value.completeness === "complete"),
            ))
          }
        }
      })
      if (covered) return true
    }
    return false
  }, channelId), { timeout: timeoutMs }).toBe(true)
}

async function waitForDurableMarker(page: Page, marker: string, timeoutMs = 2_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await durableStorageContains(page, marker)) return Date.now()
    await page.waitForTimeout(10)
  }
  return null
}

async function waitForSurface(
  page: Page,
  expectedMessageId?: string,
  timeoutMs = 20_000,
  root: Page | Locator = page,
) {
  await root.getByTestId(tid.messageScroller).last().waitFor({ state: "visible", timeout: timeoutMs })
  if (expectedMessageId) {
    await root.locator(`[data-msg-id="${expectedMessageId}"]`).waitFor({ state: "attached", timeout: timeoutMs })
  }
  await composerEditable(page, root).last().waitFor({ state: "visible", timeout: timeoutMs })
}

async function ensureThreadFixture(
  browser: Browser,
  email: string,
  parentChannelId: string,
): Promise<{ threadId: string; parentMessageId: string }> {
  const context = await browser.newContext()
  try {
    await resetOriginBeforeBootstrap(context)
    await authenticateAs(context, email)
    const parentMessages = await apiMessages(context.request, parentChannelId)
    const parent = parentMessages[0]
    if (!parent) throw new Error(`Cannot create thread fixture: ${parentChannelId} is empty`)
    const created = await context.request.post(`${BASE_URL}/api/community/channels`, {
      data: { type: "thread", messageId: parent.id, name: "replica-benchmark-thread" },
    })
    if (!created.ok()) throw new Error(`thread fixture returned ${created.status()}`)
    const { id: threadId } = await created.json() as { id: string }
    const content = "replica benchmark canonical thread tail"
    const posted = await context.request.post(`${BASE_URL}/api/community/channels/${threadId}/messages`, {
      data: { content, nonce: "replica_benchmark_thread_fixture_v1" },
    })
    if (!posted.ok()) throw new Error(`thread tail fixture returned ${posted.status()}`)
    return { threadId, parentMessageId: parent.id }
  } finally {
    await context.close()
  }
}

async function canonicalFixtureFingerprint(
  browser: Browser,
  email: string,
  channelIds: string[],
): Promise<string> {
  const context = await browser.newContext()
  try {
    await resetOriginBeforeBootstrap(context)
    await authenticateAs(context, email)
    const projections = await Promise.all(channelIds.map(async (channelId) => ({
      channelId,
      messages: (await apiMessages(context.request, channelId)).map((message) => ({
        id: message.id,
        seq: message.seq,
        content: message.content,
        clientNonce: message.clientNonce ?? null,
      })),
    })))
    return createHash("sha256").update(JSON.stringify(projections)).digest("hex")
  } finally {
    await context.close()
  }
}

async function launchProfile(profileDir: string) {
  return chromium.launchPersistentContext(profileDir, {
    baseURL: BASE_URL,
    headless: true,
    serviceWorkers: "allow",
  })
}

async function primeCoveredProfile(
  profileDir: string,
  email: string,
  routes: string[],
): Promise<Map<string, string>> {
  const context = await launchProfile(profileDir)
  const tails = new Map<string, string>()
  try {
    await resetOriginBeforeBootstrap(context)
    await authenticateAs(context, email)
    const page = context.pages()[0] ?? await context.newPage()
    for (const route of routes) {
      await page.goto(route, { waitUntil: "commit" })
      await waitForSurface(page)
      if (MODE === "gate") {
        const channelId = new URL(route, BASE_URL).pathname.split("/").at(-1)
        if (!channelId) throw new Error(`Cannot identify Replica tail for ${route}`)
        await waitForReplicaTailCoverage(page, channelId)
      }
      const tailId = await page.locator("[data-msg-id]").last().getAttribute("data-msg-id")
      if (!tailId) throw new Error(`No message tail while priming ${route}`)
      tails.set(route, tailId)
    }
    if (MODE === "gate") {
      await page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) throw new Error("service workers unavailable")
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error("service worker not ready")), 10_000)),
        ])
      })
    }
  } finally {
    await context.close()
  }
  return tails
}

async function recordSample(
  writer: ReplicaArtifactWriter,
  scenario: ReplicaScenarioId,
  iteration: number,
  journey: (sample: ReplicaBenchmarkSample) => Promise<void>,
) {
  const sample = emptySample(scenario, iteration)
  try {
    await journey(sample)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ProductFailure) sample.productFailure = message
    else sample.harnessError = message
  } finally {
    sample.observationEndedAtMs = Date.now()
    writer.append(sample)
  }
}

test("Alook Replica vertical benchmark", async ({ browser }) => {
  test.setTimeout(600_000)
  expect(["baseline", "gate"]).toContain(MODE)
  expect(process.env.NEXT_PUBLIC_MOCK_NETWORK, "mock network must be off").not.toBe("true")
  const { manifest, fixtureVersion: manifestFixtureVersion } = loadManifest()
  const server = manifest.servers.find((candidate) => candidate.channels.length >= 2)
  expect(server, "stress fixture needs a server with two channels").toBeTruthy()
  const [channelA, channelB] = server!.channels
  const routeA = `${BASE_URL}/c/channels/${server!.id}/${channelA.id}`
  const routeB = `${BASE_URL}/c/channels/${server!.id}/${channelB.id}`
  const threadFixture = await ensureThreadFixture(browser, manifest.owner.email, channelA.id)
  const threadRoute = `${BASE_URL}/c/channels/${server!.id}/${threadFixture.threadId}`
  const canonicalFingerprint = await canonicalFixtureFingerprint(
    browser,
    manifest.owner.email,
    [channelA.id, channelB.id, threadFixture.threadId],
  )
  const fixtureVersion = [
    manifestFixtureVersion,
    `thread:${threadFixture.threadId}`,
    `parent:${threadFixture.parentMessageId}`,
    `canonical-sha256:${canonicalFingerprint}`,
  ].join("+")
  if (process.env.REPLICA_BENCH_PREPARE_ONLY === "1") {
    writeFileSync(resolve(ARTIFACTS_DIR, "replica-fixture.json"), JSON.stringify({
      fixtureVersion,
      manifestPath: MANIFEST_PATH,
      threadFixture,
    }, null, 2))
    return
  }
  const serverMode = process.env.REPLICA_BENCH_SERVER_MODE
  expect(
    serverMode,
    "REPLICA_BENCH_SERVER_MODE must pin the production-like OpenNext runtime",
  ).toBe(REPLICA_BENCHMARK_SERVER_MODE)
  const gitSha = process.env.REPLICA_BENCH_GIT_SHA ?? "working-tree"
  const outputPath = process.env.REPLICA_BENCH_OUTPUT
    ?? resolve(ARTIFACTS_DIR, `replica-${MODE}.json`)
  const reportPath = outputPath.replace(/\.json$/, ".md")
  const writer = new ReplicaArtifactWriter({
    schemaVersion: REPLICA_BENCHMARK_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    fixtureVersion,
    selectedScenarios: SELECTED_SCENARIOS,
    createdAt: new Date().toISOString(),
    gitSha,
    mode: MODE,
    serverMode: serverMode as ReplicaBenchmarkServerMode,
    networkDelayMs: 1_000,
  }, outputPath)

  for (let iteration = 1; iteration <= 5; iteration += 1) {
    await recordSample(writer, "j1-covered-reopen", iteration, async (sample) => {
      const profileDir = mkdtempSync(resolve(tmpdir(), "alook-replica-j1-"))
      let context: BrowserContext | null = null
      let probe: ReplicaNetworkProbe | null = null
      try {
        const tails = await primeCoveredProfile(profileDir, manifest.owner.email, [routeA])
        const tailId = tails.get(routeA)
        if (!tailId) throw new Error("primed route has no tail identity")
        context = await launchProfile(profileDir)
        const page = context.pages()[0] ?? await context.newPage()
        probe = new ReplicaNetworkProbe(page, context, BASE_URL)
        await probe.start(MODE === "gate")
        sample.actionAtMs = Date.now()
        try {
          const legacyTimeout = MODE === "baseline" ? 40_000 : 20_000
          await page.goto(routeA, { waitUntil: "commit", timeout: legacyTimeout })
          await waitForSurface(page, tailId, legacyTimeout)
        } catch (error) {
          throw new ProductFailure(`covered reopen did not restore locally: ${String(error)}`)
        }
        sample.interactiveCoherentAtMs = Date.now()
        if (MODE === "baseline") sample.baselineObservedAtMs = sample.interactiveCoherentAtMs
        const routeCorrect = new URL(page.url()).pathname === new URL(routeA).pathname
        const tailVisible = await page.locator(`[data-msg-id="${tailId}"]`).isVisible()
        sample.proofs.push(
          proof("covered-world-visible", routeCorrect && tailVisible, `route=${page.url()} tail=${tailId}`),
          proof("transaction-consistent", routeCorrect && tailVisible, "route, message tail, and composer share one frame"),
        )
        if (!routeCorrect || !tailVisible) throw new ProductFailure("covered reopen exposed an incoherent world")
      } finally {
        if (probe) {
          sample.requests = probe.requestsSince(sample.actionAtMs)
          await probe.stop()
        }
        await context?.close().catch(() => {})
        rmSync(profileDir, { recursive: true, force: true })
      }
    })
  }

  {
    const context = await browser.newContext()
    await resetOriginBeforeBootstrap(context)
    await authenticateAs(context, manifest.owner.email)
    const page = await context.newPage()
    const apiProjection = new Map<string, ApiMessage[]>()
    for (const [route, channel] of [
      [routeA, channelA],
      [routeB, channelB],
      [threadRoute, { id: threadFixture.threadId }],
    ] as const) {
      await page.goto(route, { waitUntil: "commit" })
      await waitForSurface(page)
      apiProjection.set(channel.id, await apiMessages(context.request, channel.id))
    }
    await page.goto(routeA, { waitUntil: "commit" })
    await waitForSurface(page)
    if (MODE === "gate") await waitForReplicaTailCoverage(page, channelA.id)
    const probe = new ReplicaNetworkProbe(page, context, BASE_URL)
    await probe.start(false)
    try {
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        const target = iteration === 1
          ? { id: channelB.id, route: routeB, surface: "channel" as const }
          : iteration === 2 || iteration === 4
            ? { id: channelA.id, route: routeA, surface: "channel" as const }
            : { id: threadFixture.threadId, route: threadRoute, surface: "thread" as const }
        const expected = apiProjection.get(target.id) ?? []
        const tail = expected.at(-1)
        await recordSample(writer, "j2-covered-navigation", iteration, async (sample) => {
          if (!tail) throw new Error(`fixture channel ${target.id} has no tail`)
          sample.actionAtMs = Date.now()
          if (target.surface === "thread") {
            await page.getByTestId(tid.threadIndicator(threadFixture.parentMessageId)).click({ noWaitAfter: true })
          } else {
            await page.getByTestId(tid.channelRow(target.id)).click({ noWaitAfter: true })
          }
          try {
            await page.waitForURL(new RegExp(`/${target.id}$`), { waitUntil: "commit", timeout: 20_000 })
            const targetRoot = target.surface === "thread" ? page.getByTestId(tid.threadSplitPanel) : page
            await waitForSurface(page, tail.id, 20_000, targetRoot)
          } catch (error) {
            throw new ProductFailure(`covered navigation did not resolve coherently: ${String(error)}`)
          }
          sample.interactiveCoherentAtMs = Date.now()
          if (MODE === "baseline") sample.baselineObservedAtMs = sample.interactiveCoherentAtMs
          sample.requests = probe.requestsSince(sample.actionAtMs)
          const targetRoot = target.surface === "thread" ? page.getByTestId(tid.threadSplitPanel) : page
          const domIds = await targetRoot.locator("[data-msg-id]").evaluateAll((rows) => (
            rows.map((row) => row.getAttribute("data-msg-id")).filter(Boolean)
          ))
          const expectedIds = expected.map((message) => message.id)
          const visibleExpectedIds = expectedIds.filter((id) => domIds.includes(id))
          const read = await waitForReadThrough(context.request, target.id, tail.seq)
          const routeCorrect = new URL(page.url()).pathname === new URL(target.route).pathname
          const orderingCorrect = visibleExpectedIds.join(",") === domIds.join(",")
          const readCorrect = read.lastReadSeq === tail.seq
          const surfaceCorrect = target.surface === "thread"
            ? await page.getByTestId(tid.threadSplitPanel).isVisible()
            : await page.getByTestId(tid.threadSplitPanel).count() === 0
          sample.proofs.push(
            proof("target-tail-visible", domIds.includes(tail.id), `tail=${tail.id}`),
            proof("latest-navigation-wins", routeCorrect, `latest target=${target.id}`),
            proof("ordering-correct", orderingCorrect, `dom=${domIds.join(",")} authority=${visibleExpectedIds.join(",")}`),
            proof("read-state-correct", readCorrect, `read=${read.lastReadSeq} latest=${tail.seq}`),
            proof("route-correct", routeCorrect, page.url()),
            proof("surface-kind-correct", surfaceCorrect, `expected=${target.surface}`),
          )
          if (!routeCorrect || !orderingCorrect || !readCorrect || !surfaceCorrect) {
            throw new ProductFailure("navigation route, surface, ordering, or read projection diverged")
          }
        })
      }
    } finally {
      await probe.stop()
      await context.close()
    }
  }

  for (let iteration = 1; iteration <= 3; iteration += 1) {
    await recordSample(writer, "j5-draft", iteration, async (sample) => {
      const profileDir = mkdtempSync(resolve(tmpdir(), "alook-replica-j5-"))
      const marker = `replica-draft-${Date.now()}-${iteration}`
      let context: BrowserContext | null = null
      let probe: ReplicaNetworkProbe | null = null
      try {
        await primeCoveredProfile(profileDir, manifest.owner.email, [routeB, routeA])
        context = await launchProfile(profileDir)
        let page = context.pages()[0] ?? await context.newPage()
        await page.goto(routeA, { waitUntil: "commit" })
        await waitForSurface(page)
        await composerEditable(page).fill(marker)
        const storedBeforeClose = await waitForDurableMarker(page, marker)
        await context.close()
        context = await launchProfile(profileDir)
        page = context.pages()[0] ?? await context.newPage()
        probe = new ReplicaNetworkProbe(page, context, BASE_URL)
        await probe.start(MODE === "gate")
        sample.actionAtMs = Date.now()
        try {
          await page.goto(routeA, { waitUntil: "commit", timeout: 20_000 })
          await composerEditable(page).waitFor({ state: "visible", timeout: 20_000 })
          await expect(composerEditable(page)).toContainText(marker, { timeout: 20_000 })
        } catch (error) {
          throw new ProductFailure(`draft did not survive covered reopen: ${String(error)}`)
        }
        sample.interactiveCoherentAtMs = Date.now()
        if (MODE === "baseline") sample.baselineObservedAtMs = sample.interactiveCoherentAtMs
        const serverCount = (await apiMessages(context.request, channelA.id))
          .filter((message) => message.content === marker).length
        await page.goto(routeB, { waitUntil: "commit", timeout: 20_000 })
        await composerEditable(page).waitFor({ state: "visible", timeout: 20_000 })
        const leaked = (await composerEditable(page).textContent())?.includes(marker) ?? false
        sample.proofs.push(
          proof("draft-durable", storedBeforeClose !== null, `durable evidence at ${String(storedBeforeClose)}`),
          proof("draft-scope-isolated", !leaked, `channel ${channelB.id} contains marker=${leaked}`),
          proof("no-server-message-before-send", serverCount === 0, `authority rows=${serverCount}`),
        )
        if (storedBeforeClose === null || leaked || serverCount !== 0) {
          throw new ProductFailure("draft durability, isolation, or no-send invariant failed")
        }
      } finally {
        if (probe) {
          sample.requests = probe.requestsSince(sample.actionAtMs)
          await probe.stop()
        }
        await context?.close().catch(() => {})
        rmSync(profileDir, { recursive: true, force: true })
      }
    })
  }

  for (let iteration = 1; iteration <= 3; iteration += 1) {
    await recordSample(writer, "j6-text-send", iteration, async (sample) => {
      const profileDir = mkdtempSync(resolve(tmpdir(), "alook-replica-j6-"))
      const marker = `replica-send-${Date.now()}-${iteration}`
      let context: BrowserContext | null = null
      let probe: ReplicaNetworkProbe | null = null
      let initialRequests = sample.requests
      try {
        await primeCoveredProfile(profileDir, manifest.owner.email, [routeA])
        context = await launchProfile(profileDir)
        let page = context.pages()[0] ?? await context.newPage()
        await page.goto(routeA, { waitUntil: "commit" })
        await waitForSurface(page)
        await composerEditable(page).fill(marker)
        probe = new ReplicaNetworkProbe(page, context, BASE_URL)
        await probe.start(MODE === "gate")
        sample.actionAtMs = Date.now()
        await composerEditable(page).press("Enter")
        const row = page.locator("[data-msg-id]").filter({ hasText: marker }).last()
        try {
          await row.waitFor({ state: "attached", timeout: 20_000 })
        } catch (error) {
          throw new ProductFailure(`local text intent did not paint: ${String(error)}`)
        }
        sample.interactiveCoherentAtMs = Date.now()
        const localRowId = await row.getAttribute("data-msg-id")
        const durableAt = await waitForDurableMarker(page, marker)
        sample.localDurableAtMs = durableAt
        initialRequests = probe.requestsSince(sample.actionAtMs)
        await probe.stop()
        probe = null
        await context.close()

        context = await launchProfile(profileDir)
        page = context.pages()[0] ?? await context.newPage()
        probe = new ReplicaNetworkProbe(page, context, BASE_URL)
        await probe.start(MODE === "gate")
        let survivedReopen = false
        try {
          await page.goto(routeA, { waitUntil: "commit", timeout: 20_000 })
          const reopenedRow = page.locator("[data-msg-id]").filter({ hasText: marker }).last()
          await reopenedRow.waitFor({ state: "attached", timeout: 20_000 })
          survivedReopen = true
        } catch {}
        if (MODE === "gate") await probe.setOffline(false)
        const canonical = await waitForCanonicalCount(context.request, channelA.id, marker)
        sample.canonicalOutcomeAtMs = canonical.observedAtMs
        sample.canonicalOutcomeCount = canonical.count
        sample.businessEffectCount = canonical.count
        sample.transportDeliveryCount = [...initialRequests, ...probe.requestsSince(sample.actionAtMs)]
          .filter((request) => request.method === "POST" && request.url.includes(`/${channelA.id}/messages`))
          .length
        if (MODE === "baseline") sample.baselineObservedAtMs = canonical.observedAtMs
        const canonicalRow = canonical.messages.find((message) => message.content === marker)
        const read = await apiReadState(context.request, channelA.id)
        const intentDurable = durableAt !== null && survivedReopen
        const canonicalMatches = canonical.count === 1 && Boolean(canonicalRow)
        const readCorrect = canonicalRow ? read.lastReadSeq <= canonicalRow.seq && read.lastReadSeq >= 0 : false
        sample.proofs.push(
          proof("intent-durable", intentDurable, `stored=${String(durableAt)} reopened=${survivedReopen}`),
          proof("canonical-row-matches", canonicalMatches, `local=${String(localRowId)} canonical=${canonicalRow?.id ?? "none"}`),
          proof("read-state-correct", readCorrect, `read=${read.lastReadSeq} canonical=${canonicalRow?.seq ?? "none"}`),
        )
        if (MODE === "gate" && (!intentDurable || !canonicalMatches || !readCorrect)) {
          throw new ProductFailure("text intent durability or canonical exactly-once invariant failed")
        }
      } finally {
        if (probe) {
          sample.requests = [...initialRequests, ...probe.requestsSince(sample.actionAtMs)]
          await probe.stop()
        } else {
          sample.requests = initialRequests
        }
        await context?.close().catch(() => {})
        rmSync(profileDir, { recursive: true, force: true })
      }
    })
  }

  const baselinePath = process.env.REPLICA_BENCH_BASELINE
  const baseline = baselinePath
    ? JSON.parse(readFileSync(baselinePath, "utf8")) as ReplicaBenchmarkArtifact
    : undefined
  writer.flush()
  writeFileSync(reportPath, renderReplicaBenchmarkReport(writer.artifact, baseline))
  const analysis = analyzeReplicaBenchmark(writer.artifact, baseline)
  expect(analysis.artifactValid, `invalid benchmark artifact; see ${reportPath}`).toBe(true)
  if (MODE === "gate") {
    expect(baseline, "REPLICA_BENCH_BASELINE is required in gate mode").toBeTruthy()
    expect(analysis.runPassed, `Replica gate failed; see ${reportPath}`).toBe(true)
  }
})
