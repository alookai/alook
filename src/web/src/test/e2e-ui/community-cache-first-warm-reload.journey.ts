import { createRequire } from "node:module"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { CONTROL_HEARTBEAT_CAPABILITY, DEV_PASSWORD, HostReadyMessageSchema } from "@alook/shared"
import { HostCommandSchema } from "@alook/shared/community-cli-contract"
import { MACHINE_WS_URL, REPO_ROOT, WEB_URL } from "./_setup/paths"
import type { APIResponse, Page, Request, TestInfo } from "@playwright/test"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { expectPublicCommunityDocument, expectUniqueSsrCommunityFrame } from "./_fixtures/community-ssr-frame"
import { PERSIST_CACHE_PREFIX } from "@/lib/query-persister"
import { expect, test } from "./_fixtures/case-fixture"

import { tid } from "./_fixtures/testids"
import type { CaseResources } from "./_fixtures/case-fixture"

type ReloadCapture = {
  customBootstrapSeen: boolean
  skeletonSeen: boolean
  firstSkeleton: string | null
  marks: Record<"start" | "complete" | "cached" | "stable", number>
}

type PersistedExpectation = {
  key: readonly unknown[]
  containsId?: string
}

type PersistedQuery = {
  queryKey: unknown[]
  data: unknown
}

const structuralLoadingSelectors = [
  '[aria-label="Loading community"]',
  "[data-message-list-skeleton]",
  `[data-testid^="${tid.pendingMain("")}"]`,
  `[data-testid="${tid.initialRailPending}"]`,
  `[data-testid="${tid.dmSidebarPending}"]`,
  `[data-testid^="${tid.channelSidebarPending("")}"]`,
]

async function persistedQueries(page: Page, viewerId: string): Promise<PersistedQuery[]> {
  return page.evaluate((key) => new Promise<PersistedQuery[]>((resolve, reject) => {
    const open = indexedDB.open("keyval-store")
    open.onerror = () => reject(open.error ?? new Error("failed to open query persister"))
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains("keyval")) {
        db.close()
        resolve([])
        return
      }
      const request = db.transaction("keyval", "readonly").objectStore("keyval").get(key)
      request.onerror = () => {
        db.close()
        reject(request.error ?? new Error("failed to read query persister"))
      }
      request.onsuccess = () => {
        db.close()
        if (typeof request.result !== "string") {
          resolve([])
          return
        }
        const persisted = JSON.parse(request.result) as {
          clientState?: {
            queries?: Array<{ queryKey?: unknown[]; state?: { data?: unknown } }>
          }
        }
        resolve((persisted.clientState?.queries ?? []).flatMap((query) => (
          Array.isArray(query.queryKey)
            ? [{ queryKey: query.queryKey, data: query.state?.data }]
            : []
        )))
      }
    }
  }), `${PERSIST_CACHE_PREFIX}:${viewerId}:client`)
}

function containsPersistedId(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsPersistedId(entry, id))
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return Object.values(record).some((entry) => (
    entry === id || containsPersistedId(entry, id)
  ))
}

async function expectPersistedClosure(
  page: Page,
  viewerId: string,
  expected: readonly PersistedExpectation[],
) {
  const missingClosure = async () => {
    const queries = await persistedQueries(page, viewerId)
    const persisted = new Map(
      queries.map((query) => [JSON.stringify(query.queryKey), query.data]),
    )
    const failures = expected.flatMap(({ key, containsId }) => {
      const hash = JSON.stringify(key)
      if (!persisted.has(hash)) return [`missing ${hash}`]
      if (containsId && !containsPersistedId(persisted.get(hash), containsId)) {
        return [`${hash} missing entity ${containsId}`]
      }
      return []
    })
    const windows = queries.filter(({ queryKey }) => queryKey[0] === "community"
      && (queryKey[1] === "channel" || queryKey[1] === "dm") && queryKey[3] === "messages")
    for (const window of windows) {
      const value = window.data as { pages?: Array<{ messages?: Array<Record<string, unknown>> }>; pageParams?: unknown[] }
      if (!Array.isArray(value?.pages) || !value.pages.length || !Array.isArray(value.pageParams) || value.pages.length !== value.pageParams.length
        || value.pages.some(page => !Array.isArray(page.messages) || page.messages.some(message => typeof message.id !== "string" || Object.keys(message).some(key => key !== "id" && key !== "seq")))) failures.push(`invalid window or copied body ${JSON.stringify(window.queryKey)}`)
    }
    return failures
  }
  await expect.poll(missingClosure, { timeout: 20_000 }).toEqual([])
  // The async persister coalesces cache events on a one-second throttle. A
  // single matching read can still observe the previous blob while a final
  // write is queued. Require both the keys and target entities to survive one
  // throttle interval before reloading under blocked network conditions.
  await page.waitForTimeout(1_100)
  await expect.poll(missingClosure, { timeout: 20_000 }).toEqual([])
}

async function clearQueryPersistence(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("keyval-store")
    open.onerror = () => reject(open.error ?? new Error("failed to open query persister"))
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains("keyval")) {
        db.close()
        resolve()
        return
      }
      const transaction = db.transaction("keyval", "readwrite")
      transaction.objectStore("keyval").clear()
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => {
        db.close()
        reject(transaction.error ?? new Error("failed to clear query persister"))
      }
    }
  }))
}

async function expectCacheFirstReload(
  page: Page,
  assertEntryContent: () => Promise<void>,
  assertCachedContent: () => Promise<void>,
  assertReconciledContent: () => Promise<void>, caseResources: CaseResources, independentParentEntry?: string
): Promise<ReloadCapture> {
  await page.addInitScript((loadingSelectors) => {
    const state = {
      customBootstrapSeen: false,
      skeletonSeen: false,
      firstSkeleton: null as string | null,
    }
    Object.defineProperty(window, "__cacheFirstReload", {
      configurable: true,
      value: state,
    })
    const inspect = () => {
      if (document.querySelector('[data-slot="community-restore-bootstrap"]')) {
        state.customBootstrapSeen = true
      }
      const skeleton = document.querySelector(loadingSelectors.join(","))
      if (skeleton) {
        state.skeletonSeen = true
        state.firstSkeleton ??= [
          skeleton.outerHTML.slice(0, 300),
          ...Array.from({ length: 5 }, (_, index) => {
            let ancestor = skeleton.parentElement
            for (let step = 0; step < index; step += 1) ancestor = ancestor?.parentElement ?? null
            if (!ancestor) return ""
            return `${ancestor.tagName.toLowerCase()}#${ancestor.id}.${ancestor.className}`
          }).filter(Boolean),
        ].join(" <- ")
      }
    }
    new MutationObserver(inspect).observe(document, { childList: true, subtree: true })
    inspect()
  }, structuralLoadingSelectors)

  let releaseReads!: () => void
  const readsGate = new Promise<void>((resolve) => { releaseReads = resolve })
  caseResources.own(releaseReads, async (captured) => { captured() })
  let releaseMessages!: () => void
  const messagesGate = new Promise<void>((resolve) => { releaseMessages = resolve })
  caseResources.own(releaseMessages, async (captured) => { captured() })
  let heldReads = 0
  let forwardedMessages = 0
  let forwardedParentEntries = 0
  await page.route("**/api/community/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    const url = new URL(route.request().url())
    const path = url.pathname
    const parentEntry = independentParentEntry && path === `/api/community/channels/${independentParentEntry}/messages` && url.searchParams.get("entry") === "1"
    const childEntry = url.searchParams.get("entry") === "1" && path.endsWith("/messages") && !parentEntry
    if (childEntry) {
      await route.continue()
      return
    }
    if (parentEntry) {
      heldReads += 1
      await readsGate
      forwardedParentEntries += 1
    } else if (/\/(messages|pins|threads)(\/|$)/.test(path)) {
      await messagesGate
      forwardedMessages += 1
    } else {
      heldReads += 1
      await readsGate
    }
    await route.continue().catch(() => { })
  })
  let wsAttempts = 0
  await page.routeWebSocket((url) => url.pathname.endsWith("/user"), (socket) => {
    wsAttempts += 1
    void socket.close({ code: 1012, reason: "cache-first warm reload probe" })
  })

  try {
    await page.reload({ waitUntil: "commit" })
    await assertEntryContent()
    await expect.poll(() => heldReads).toBeGreaterThan(0)
    await expect.poll(() => wsAttempts).toBeGreaterThan(0)
    const readCapture = () => page.evaluate((): ReloadCapture | null => {
      const state = (window as unknown as {
        __cacheFirstReload?: {
          customBootstrapSeen: boolean
          skeletonSeen: boolean
          firstSkeleton: string | null
        }
      }).__cacheFirstReload
      const latest = (name: string) => performance.getEntriesByName(name, "mark").at(-1)?.startTime
      const marks = {
        start: latest("alook:restore:start"),
        complete: latest("alook:restore:complete"),
        cached: latest("alook:restore:first-cached-paint"),
        stable: latest("alook:restore:stable"),
      }
      if (Object.values(marks).some((mark) => mark === undefined)) {
        return null
      }
      return {
        customBootstrapSeen: state?.customBootstrapSeen === true,
        skeletonSeen: state?.skeletonSeen === true,
        firstSkeleton: state?.firstSkeleton ?? null,
        marks: marks as ReloadCapture["marks"],
      }
    })
    await expect.poll(readCapture, { timeout: 10_000 }).not.toBeNull()
    const capture = await readCapture()
    if (!capture) throw new Error("warm reload restore lifecycle marks are incomplete")
    expect(capture.customBootstrapSeen).toBe(false)
    expect(capture.skeletonSeen, capture.firstSkeleton ?? "warm reload regional skeleton").toBe(true)
    expect(capture.marks.complete).toBeGreaterThanOrEqual(capture.marks.start)
    expect(capture.marks.cached).toBeGreaterThanOrEqual(capture.marks.complete)
    expect(capture.marks.stable).toBeGreaterThanOrEqual(capture.marks.cached)
    releaseReads()
    await assertCachedContent()
    if (independentParentEntry) expect(forwardedParentEntries).toBe(1)
    expect(forwardedMessages).toBe(0)
    releaseMessages()
    await assertReconciledContent()
    return capture
  } finally {
    releaseReads()
    releaseMessages()
    await page.unroute("**/api/community/**")
  }
}

test("a warm channel reload shows entry-qualified cached content while browser reads remain held", async ({ caseActors, caseResources }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser, userId } = actors
  const { seedChannel, seedMessage, seedServer } = actors.seed

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Warm channel ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `warm-${suffix}`)
  const body = `cached channel ${suffix}`
  const messageId = await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectPersistedClosure(page, userId("alice"), [
    { key: ["community", "db", userId("alice"), "servers"], containsId: serverId },
    { key: ["community", "db", userId("alice"), "folders"] },
    { key: ["community", "db", userId("alice"), "channels"], containsId: channelId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: messageId },
  ])

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
    await expect(page.getByTestId(tid.message(messageId)).getByText(body, { exact: false })).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  }, async () => {
    await expect(page.getByTestId(tid.message(messageId))).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(tid.message(messageId)).getByText(body, { exact: false })).toBeVisible()
  }, async () => {
    await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  }, caseResources)
})

test("a warm DM reload shows entry-qualified identity and history before browser reads", async ({ caseActors, caseResources }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser, userId, userName } = actors
  const { seedDm, seedDmMessage } = actors.seed

  const dmId = await seedDm("alice", userId("bob"))
  const body = `cached dm ${Date.now()}`
  const messageId = await seedDmMessage("bob", dmId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/me/${dmId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectPersistedClosure(page, userId("alice"), [
    { key: ["community", "db", userId("alice"), "servers"] },
    { key: ["community", "db", userId("alice"), "folders"] },
    { key: ["community", "db", userId("alice"), "channels"], containsId: dmId },
    { key: ["community", "db", userId("alice"), "channelMemberships"], containsId: dmId },
    { key: ["community", "db", userId("alice"), "profiles"], containsId: userId("bob") },
    { key: ["community", "db", userId("alice"), "messages"], containsId: messageId },
  ])

  await expectCacheFirstReload(page, async () => {
    const frame = await expectUniqueSsrCommunityFrame(page)
    await expect(frame.getByTestId(tid.dmRow(dmId))).toBeVisible({ timeout: 10_000 })
    await expect(frame.getByTestId(tid.dmHeader)).toBeVisible()
    await expect(frame.getByTestId(tid.dmHeader)).toContainText(userName("bob"))
    await expect(frame.locator(`main[data-slot="community-conversation-surface"][data-channel-id="${dmId}"]`)).toBeVisible()
    await expect(frame.getByTestId(tid.message(messageId))).toBeVisible()
    await expect(frame.getByTestId(tid.message(messageId)).getByText(body, { exact: false })).toBeVisible()
    await expect(frame.getByTestId(tid.composerInput)).toBeVisible()
  }, async () => {
    const frame = await expectUniqueSsrCommunityFrame(page)
    await expect(frame.getByTestId(tid.dmHeader)).toBeVisible({ timeout: 20_000 })
    await expect(frame.getByTestId(tid.message(messageId))).toBeVisible()
    await expect(frame.getByTestId(tid.message(messageId)).getByText(body, { exact: false })).toBeVisible()
  }, async () => {
    const frame = await expectUniqueSsrCommunityFrame(page)
    await expect(frame.getByTestId(tid.message(messageId))).toBeVisible()
    await expect(frame.getByTestId(tid.composerInput)).toBeVisible()
  }, caseResources)
})

test("a warm desktop thread reload qualifies its child and independently reconciles its parent entry", async ({ caseActors, caseResources }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser, userId } = actors
  const { seedChannel, seedMessage, seedServer, seedThread } = actors.seed

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Warm split ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `split-${suffix}`)
  const parentBody = `cached parent ${suffix}`
  const openerId = await seedMessage("alice", channelId, parentBody)
  const threadId = await seedThread("alice", openerId, `thread-${suffix}`)
  const threadBody = `cached thread ${suffix}`
  const threadMessageId = await seedMessage("alice", threadId, threadBody)
  const { page } = await asUser("alice", { viewport: { width: 1280, height: 900 } })
  await page.goto(`/c/channels/${serverId}/${threadId}`)
  await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split", {
    timeout: 20_000,
  })
  await expect(page.getByText(threadBody, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectPersistedClosure(page, userId("alice"), [
    { key: ["community", "db", userId("alice"), "servers"], containsId: serverId },
    { key: ["community", "db", userId("alice"), "folders"] },
    { key: ["community", "db", userId("alice"), "channels"], containsId: channelId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: openerId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: threadMessageId },
  ])

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-community-conversation-subtype", "thread")
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.message(threadMessageId))).toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.composerInput)).toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.message(threadMessageId))).toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByText(threadBody, { exact: false })).toBeVisible()
    await expect(page.getByTestId(tid.threadSplitParent).getByTestId(tid.message(openerId))).toHaveCount(0)
  }, async () => {
    await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split", {
      timeout: 10_000,
    })
    await expect(page.getByTestId(tid.threadSplitParent).getByTestId(tid.message(openerId)))
      .toBeVisible()
    await expect(page.getByTestId(tid.threadSplitParent).getByText(parentBody, { exact: false }))
      .toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.message(threadMessageId)))
      .toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByText(threadBody, { exact: false }))
      .toBeVisible()
  }, async () => {
    await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split")
    await expect(page.getByTestId(tid.threadSplitParent).getByText(parentBody, { exact: false }))
      .toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByText(threadBody, { exact: false }))
      .toBeVisible()
    await expect(page.getByTestId(tid.threadSplitParent).getByTestId(tid.composerInput)).toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByTestId(tid.composerInput)).toBeVisible()
  }, caseResources, channelId)
})

test("a true-cold channel load reuses localized skeletons without a custom bootstrap", async ({ caseActors, caseResources }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedMessage, seedServer } = actors.seed

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Cold control ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `cold-${suffix}`)
  const body = `network channel ${suffix}`
  await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.goto("/")
  await clearQueryPersistence(page)
  // Clearing IndexedDB does not cancel the current page's already queued
  // throttled persist. Let that write drain, then clear once more so the next
  // document really starts without a disk snapshot.
  await page.waitForTimeout(1_100)
  await clearQueryPersistence(page)
  await page.addInitScript((loadingSelectors) => {
    const state = {
      customBootstrapSeen: false,
      localizedSkeletonAfterRestore: false,
      sessionFrameSeen: false,
    }
    Object.defineProperty(window, "__cacheFirstColdControl", {
      configurable: true,
      value: state,
    })
    const inspect = () => {
      if (document.querySelector('[data-slot="community-restore-bootstrap"]')) {
        state.customBootstrapSeen = true
      }
      if (document.querySelector('[aria-label="Loading community"]')) {
        state.sessionFrameSeen = true
      }
      if (
        performance.getEntriesByName("alook:restore:complete", "mark").length > 0
        && document.querySelector(loadingSelectors.join(","))
      ) state.localizedSkeletonAfterRestore = true
    }
    new MutationObserver(inspect).observe(document, { childList: true, subtree: true })
    // Restore lifecycle marks do not mutate the DOM. Observe marks as well so
    // a skeleton that is already mounted when `restore:complete` lands is not
    // missed merely because no later DOM mutation happens in a fast CI run.
    new PerformanceObserver(inspect).observe({ type: "mark", buffered: true })
    inspect()
  }, structuralLoadingSelectors)

  let releaseReads!: () => void
  const readsGate = new Promise<void>((resolve) => { releaseReads = resolve })
  caseResources.own(releaseReads, async (captured) => { captured() })
  let heldReads = 0
  await page.route("**/api/community/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    heldReads += 1
    await readsGate
    await route.continue().catch(() => {})
  })

  try {
    await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
    await expect.poll(() => page.evaluate(() => {
      return (window as unknown as {
        __cacheFirstColdControl?: {
          customBootstrapSeen: boolean
          localizedSkeletonAfterRestore: boolean
          sessionFrameSeen: boolean
        }
      }).__cacheFirstColdControl
    })).toMatchObject({
      customBootstrapSeen: false,
      localizedSkeletonAfterRestore: true,
      sessionFrameSeen: true,
    })
    await expect.poll(() => heldReads).toBeGreaterThan(0)
    expect(await page.evaluate(() => (
      performance.getEntriesByName("alook:restore:first-cached-paint", "mark").length
    ))).toBe(0)
    await expect(page.getByText(body, { exact: false })).toHaveCount(0)
    await expect(page.getByTestId(tid.composerInput)).toHaveCount(0)
  } finally {
    releaseReads()
    await page.unroute("**/api/community/**")
  }
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
})

async function holdOriginalPersistedRead(page: Page, viewerId: string, oldId: string, newId: string) {
  await page.addInitScript(({ key, accountKey, channelsKey, oldId, newId }) => {
    const original = IDBObjectStore.prototype.get
    const originalCursor = IDBObjectStore.prototype.openCursor
    const cursorTransactions = new WeakSet<IDBTransaction>()
    let selectedPayload = false
    IDBObjectStore.prototype.openCursor = function (...args) {
      const request = originalCursor.apply(this, args)
      if (this.transaction.db.name === "keyval-store" && this.name === "keyval") cursorTransactions.add(this.transaction)
      return request
    }
    const pending: Array<() => void> = []
    let reads = 0
    type RetirementCheck = { complete: boolean; accountChanged: boolean; scopeChanged: boolean; channelsReset: boolean }
    let expectedAccount: unknown
    let expectedScope: unknown
    const checks = new WeakMap<IDBTransaction, { account?: unknown; scope?: unknown; channels?: unknown }>()
    const observedTransactions = new WeakMap<IDBTransaction, { id: number; keys: string[] }>()
    let transactionSequence = 0
    type HeldRequest = { id: number; mode: IDBTransactionMode; priorKeys: string[]; callsite: string[]; completedAt: number | null; abortedAt: number | null }
    const state = { heldRequest: null as HeldRequest | null, held: 0, oldPresent: false, newPresent: false, released: false,
      retirementCheck: null as RetirementCheck | null,
      diagnostics: { beforeRelease: [] as Array<Record<string, unknown>>, afterRelease: [] as Array<Record<string, unknown>> },
      release: () => { state.released = true; record({ event: "release", pending: pending.length }); for (const complete of pending.splice(0)) complete() } }
    function record(event: Record<string, unknown>) {
      const entries = state.released ? state.diagnostics.afterRelease : state.diagnostics.beforeRelease
      if (state.released && entries.length >= 32) return
      if (entries.length >= 32) entries.shift()
      entries.push({ at: performance.now(), ...event })
    }
    function staticCallsite() {
      return (new Error().stack ?? "").split("\n").slice(1, 9).flatMap(line => {
        const match = line.match(/https?:\/\/[^\s)]+/)
        if (!match) return []
        try {
          const location = new URL(match[0])
          const path = location.pathname.match(/^\/_next\/static\/[A-Za-z0-9_./%+-]+\.js:\d+:\d+$/)?.[0]
          return path && path.length <= 240 ? [path] : []
        } catch { return [] }
      }).slice(0, 4)
    }
    Reflect.set(window, "__217DiskRead", state)
    IDBObjectStore.prototype.get = function (query) {
      const ownedStore = this.transaction.db.name === "keyval-store" && this.name === "keyval"
      const kind = !ownedStore ? undefined : query === key ? "payload" : query === key + ":epoch" ? "scope"
        : query === accountKey ? "account" : query === channelsKey ? "channels" : query === "alook:qc:device-epoch" ? "device" : undefined
      const priorKeys = [...(observedTransactions.get(this.transaction)?.keys ?? [])]
      const callsite = kind ? staticCallsite() : []
      let request: ReturnType<IDBObjectStore["get"]>
      try { request = original.call(this, query) } catch (error) {
        if (kind) record({ event: "get-throw", id: observedTransactions.get(this.transaction)?.id ?? null, kind, priorKeys, callsite, mode: this.transaction.mode, name: error instanceof Error ? error.name : "unknown" })
        throw error
      }
      if (kind) {
        const transaction = this.transaction
        let receipt = observedTransactions.get(transaction)
        if (!receipt) {
          receipt = { id: ++transactionSequence, keys: [] }
          observedTransactions.set(transaction, receipt)
          const id = receipt.id
          transaction.addEventListener("complete", () => {
            if (state.heldRequest?.id === id) state.heldRequest.completedAt = performance.now()
            record({ event: "transaction-complete", id, mode: transaction.mode })
          }, { once: true })
          transaction.addEventListener("abort", () => {
            if (state.heldRequest?.id === id) state.heldRequest.abortedAt = performance.now()
            record({ event: "transaction-abort", id, mode: transaction.mode, name: transaction.error?.name ?? null })
          }, { once: true })
        }
        const id = receipt.id
        record({ event: "get", id, mode: transaction.mode, kind, priorKeys: [...receipt.keys] })
        receipt.keys.push(kind)
        request.addEventListener("success", event => record({ event: "request-success", id, kind, trusted: event.isTrusted }))
        request.addEventListener("error", () => record({ event: "request-error", id, kind, name: request.error?.name ?? null }), { once: true })
      }
      if (ownedStore && (query === accountKey || query === `${key}:epoch` || query === channelsKey)) {
        const transaction = this.transaction
        const afterRelease = state.released && transaction.mode === "readonly"
        request.addEventListener("success", () => {
          const value: unknown = request.result
          if (!state.released && transaction.mode === "readwrite") {
            if (query === accountKey && expectedAccount === undefined) expectedAccount = value
            if (query === `${key}:epoch` && expectedScope === undefined) expectedScope = value
          }
          if (!afterRelease || state.retirementCheck) return
          let check = checks.get(transaction)
          if (!check) {
            check = {}
            checks.set(transaction, check)
            transaction.addEventListener("complete", () => {
              const completed = checks.get(transaction)!
              if (state.retirementCheck || !("account" in completed) || !("scope" in completed) || !("channels" in completed)) return
              state.retirementCheck = {
                complete: true,
                accountChanged: typeof expectedAccount === "string" && completed.account !== expectedAccount,
                scopeChanged: expectedScope !== undefined && JSON.stringify(completed.scope) !== JSON.stringify(expectedScope),
                channelsReset: completed.channels instanceof Map && completed.channels.size === 0,
              }
            }, { once: true })
          }
          if (query === accountKey) check.account = value
          if (query === `${key}:epoch`) check.scope = value
          if (query === channelsKey) check.channels = value
        }, { once: true })
      }
      if (ownedStore && query === key) reads += 1
      if (ownedStore && query === key && !selectedPayload && this.transaction.mode === "readwrite"
        && !cursorTransactions.has(this.transaction) && priorKeys.length === 4
        && priorKeys.every((kind, index) => kind === ["device", "scope", "account", "channels"][index])) {
        selectedPayload = true
        request.addEventListener("success", event => {
          if (state.released) return
          event.stopImmediatePropagation()
          state.held += 1
          const receipt = observedTransactions.get(this.transaction)!
          state.heldRequest = { id: receipt.id, mode: this.transaction.mode, priorKeys, callsite, completedAt: null, abortedAt: null }
          const value = typeof request.result === "string" ? request.result : ""
          state.oldPresent = value.includes(oldId)
          state.newPresent = value.includes(newId)
          record({ event: "payload-held", id: observedTransactions.get(this.transaction)?.id ?? null, payloadRead: reads, mode: this.transaction.mode, trusted: event.isTrusted })
          pending.push(() => {
            record({ event: "dispatch-begin" })
            try { record({ event: "dispatch-return", accepted: request.dispatchEvent(new Event(event.type, { bubbles: event.bubbles, cancelable: event.cancelable })) }) } catch (error) {
              record({ event: "dispatch-throw", name: error instanceof Error ? error.name : "unknown" })
              throw error
            }
          })
        }, { once: true })
      }
      return request
    }
  }, { key: `${PERSIST_CACHE_PREFIX}:${viewerId}:client`, accountKey: `${PERSIST_CACHE_PREFIX}:${viewerId}:account-epoch`, channelsKey: `${PERSIST_CACHE_PREFIX}:${viewerId}:account-epoch:channels`, oldId, newId })
}

async function captureOriginalPersistedReadDiagnostics(page: Page, testInfo: TestInfo, label: string) {
  const snapshot = page.isClosed() ? { pageClosed: true } : await page.evaluate(() => {
    const state = Reflect.get(window, "__217DiskRead") as {
      held: number; oldPresent: boolean; newPresent: boolean; released: boolean;
      heldRequest: unknown; retirementCheck: unknown; diagnostics: unknown
    } | undefined
    return state ? {
      held: state.held, oldPresent: state.oldPresent, newPresent: state.newPresent,
      heldRequest: state.heldRequest, released: state.released, retirementCheck: state.retirementCheck, diagnostics: state.diagnostics,
      marks: { start: performance.getEntriesByName("alook:restore:start", "mark").length,
        complete: performance.getEntriesByName("alook:restore:complete", "mark").length },
    } : { stateMissing: true }
  })
  await testInfo.attach("original-idb-read-diagnostics-" + label, { body: JSON.stringify(snapshot), contentType: "application/json" })
}

async function releaseOriginalPersistedRead(page: Page) {
  if (!page.isClosed()) await page.evaluate(() => {
    (Reflect.get(window, "__217DiskRead") as { release?: () => void } | undefined)?.release?.()
  })
}

async function retiredAccountDiskState(page: Page, viewerId: string, channelId: string) {
  return page.evaluate(({ prefix, viewerId, channelId }) => new Promise<{ payloadAbsent: boolean; applicationPayloadAbsent: boolean; accountEpochPresent: boolean; scopeEpochPresent: boolean; channelsReset: boolean; oldChannelFenceAbsent: boolean }>((resolveState, reject) => {
    const open = indexedDB.open("keyval-store")
    open.onerror = () => reject(open.error ?? new Error("failed to inspect retired account"))
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction("keyval", "readonly")
      const store = transaction.objectStore("keyval")
      const namespace = `${prefix}:${viewerId}`
      const payload = store.get(`${namespace}:client`)
      const application = store.get(`${namespace}:application:client`)
      const account = store.get(`${namespace}:account-epoch`)
      const scope = store.get(`${namespace}:client:epoch`)
      const channels = store.get(`${namespace}:account-epoch:channels`)
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("retired account inspection failed")) }
      transaction.oncomplete = () => {
        const fences: unknown = channels.result
        const result = { payloadAbsent: payload.result === undefined, applicationPayloadAbsent: application.result === undefined, accountEpochPresent: typeof account.result === "string", scopeEpochPresent: typeof scope.result === "string", channelsReset: fences instanceof Map && fences.size === 0, oldChannelFenceAbsent: fences instanceof Map && !fences.has(channelId) }
        db.close()
        resolveState(result)
      }
    }
  }), { prefix: PERSIST_CACHE_PREFIX, viewerId, channelId })
}

test("late original IDB cannot revive a DM after a real WS block", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)
  const actors = await caseActors(["alice", "bob"])
  const { asUser, userId } = actors
  const { seedDm, seedDmMessage } = actors.seed
  const dmId = await seedDm("alice", userId("bob"))
  const oldId = await seedDmMessage("bob", dmId, `old persisted DM ${Date.now()}`)
  const alice = await asUser("alice")
  const bob = await asUser("bob")
  await alice.page.goto(`/c/me/${dmId}`)
  await expect(alice.page.getByTestId(tid.message(oldId))).toBeVisible()
  await expectPersistedClosure(alice.page, userId("alice"), [
    { key: ["community", "db", userId("alice"), "messages"], containsId: oldId },
  ])
  await alice.page.goto("/")
  const newBody = `new private DM ${Date.now()}`
  const newId = await seedDmMessage("bob", dmId, newBody)
  await holdOriginalPersistedRead(alice.page, userId("alice"), oldId, newId)
  caseResources.own(alice.page, releaseOriginalPersistedRead)
  caseResources.own(alice.page, captured => captureOriginalPersistedReadDiagnostics(captured, testInfo, "late-block"))
  const proxy = await proxyCommunityWebSockets(alice.context)
  const targetGets: string[] = []
  const pattern = (url: URL) => url.pathname === `/api/community/channels/${dmId}/messages`
  let releaseNetwork!: () => void
  const networkGate = new Promise<void>(resolve => { releaseNetwork = resolve })
  caseResources.own(releaseNetwork, async captured => { captured() })
  await alice.page.route(pattern, async route => { targetGets.push(route.request().url()); await networkGate; await route.continue() })
  try {
    const response = await alice.page.goto(`/c/me/${dmId}`, { waitUntil: "commit" })
    expect(response?.status()).toBe(200)
    const originalHtml = await response!.text()
    expectPublicCommunityDocument(originalHtml)
    expect(originalHtml).not.toContain(newId)
    await expect.poll(() => alice.page.evaluate(() => {
      const state = Reflect.get(window, "__217DiskRead") as { held: number; oldPresent: boolean; newPresent: boolean }
      return { held: state.held, oldPresent: state.oldPresent, newPresent: state.newPresent }
    })).toEqual({ held: 1, oldPresent: true, newPresent: false })
    await expect(alice.page.getByTestId(tid.message(oldId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.message(newId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveCount(0)
    expect(targetGets).toEqual([])
    await expect.poll(() => proxy.connectionFrames.some(frame => frame.type === "auth.ok")).toBe(true)
    const blocked = await bob.page.request.post(`/api/community/users/${userId("alice")}/block`)
    expect(blocked.status()).toBe(200)
    await expect.poll(() => proxy.frames.some(frame => frame.type === "community:friend.block" && frame.userId === userId("bob"))).toBe(true)
    const denied = await alice.page.request.get(`/api/community/channels/${dmId}/messages?entry=1`, { headers: { "x-alook-community-contract": "3" } })
    expect(denied.status()).toBe(403)
    await expect(alice.page.getByTestId(tid.message(oldId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.message(newId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveCount(0)
    await releaseOriginalPersistedRead(alice.page)
    releaseNetwork()
    await expect.poll(() => alice.page.evaluate(() => performance.getEntriesByName("alook:restore:complete", "mark").length)).toBe(1)
    await expect(alice.page.getByRole("alert").filter({ hasText: "You can no longer read this conversation." })).toBeVisible()
    await expect(alice.page).toHaveURL(new RegExp(`/c/me/${dmId}$`))
    await expect(alice.page.getByTestId(tid.message(oldId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.message(newId))).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveCount(0)
    await testInfo.attach("late-idb-public-shell-ws-boundaries", { body: JSON.stringify({ dmId, oldId, newId, originalHtmlContainsNewId: originalHtml.includes(newId), denied: denied.status(), wsBlock: proxy.frames.filter(frame => frame.type === "community:friend.block").map(frame => ({ type: frame.type, userId: frame.userId })) }), contentType: "application/json" })
  } finally {
    await releaseOriginalPersistedRead(alice.page)
    releaseNetwork()
    await alice.page.unroute(pattern)
  }
})

test("a real empty machine list is usable before optional observations or bots return", async ({ caseActors, caseResources }, testInfo) => {
  const actors = await caseActors(["alice"])
  const { page } = await actors.asUser("alice", { viewport: { width: 1280, height: 900 } })
  let releaseOptional!: () => void
  const optionalGate = new Promise<void>(resolve => { releaseOptional = resolve })
  caseResources.own(releaseOptional, async captured => { captured() })
  const optional = (url: URL) => url.pathname === "/api/community/machines" && url.searchParams.get("view") === "observations"
  const bots = (url: URL) => url.pathname === "/api/community/bots"
  const statuses: number[] = []
  await page.route(optional, async route => { const response = await route.fetch(); statuses.push(response.status()); await optionalGate; await route.fulfill({ response }) })
  await page.route(bots, async route => { await optionalGate; await route.continue() })
  try {
    const requested = page.waitForRequest(request => optional(new URL(request.url())))
    const listResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/community/machines" && new URL(response.url()).searchParams.get("view") === "list")
    await page.goto("/c/me/friends")
    await expect(page.getByRole("link", { name: "Machines", exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Machines", exact: true }).click()
    await requested
    const list = await listResponse
    expect(list.status()).toBe(200)
    expect(await list.json()).toMatchObject({ machines: [] })
    await expect(page.getByRole("heading", { name: "No machines yet", exact: true })).toBeVisible()
    await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible()
    await expect(page.getByTestId(tid.pendingMain("machines"))).toHaveCount(0)
    const delivered = page.waitForResponse(response => optional(new URL(response.url())))
    releaseOptional()
    const actualOptional = await delivered
    expect(actualOptional.status()).toBe(200)
    expect(await actualOptional.json()).toMatchObject({ machineCapacity: { ownedCount: 0 } })
    await expect.poll(() => statuses.length).toBeGreaterThan(0)
    expect(statuses.every(status => status === 200)).toBe(true)
    await expect(page.getByRole("heading", { name: "No machines yet", exact: true })).toBeVisible()
    await testInfo.attach("machine-empty-primary", { body: JSON.stringify({ listStatus: list.status(), machines: [], optionalStatuses: statuses }), contentType: "application/json" })
  } finally {
    releaseOptional()
    await page.unroute(optional)
    await page.unroute(bots)
  }
})

async function activateRealMachine(page: Page, caseResources: CaseResources) {
  const paired = await page.request.post("/api/community/machines/pair")
  expect(paired.status()).toBe(200)
  const { tokenId } = await paired.json() as { tokenId: string }
  const activationProof: { response?: APIResponse; machineId?: string } = {}
  const pairingToken = caseResources.own(tokenId, async () => {
    if (!activationProof.response?.ok() || !activationProof.machineId) throw new Error("Pairing token consumption is UNKNOWN; this case must stop")
  })
  const hostname = `native-loading-${Date.now()}`
  const activated = await page.request.post("/api/community/daemon/activate", {
    headers: { Authorization: `Bearer ${tokenId}` },
    data: { hostname, platform: "linux", arch: "x64", osRelease: "e2e", daemonVersion: (JSON.parse(readFileSync(resolve(REPO_ROOT, "src/daemon/package.json"), "utf8")) as { version: string }).version, runtimeReport: [{ id: "pi", status: "healthy" }] },
  })
  expect(activated.status()).toBe(200)
  const { machineId, credential } = await activated.json() as { machineId: string; credential: string }
  caseResources.own(machineId, async id => { const removed = await page.request.delete(`/api/community/machines/${id}`); expect([204, 404]).toContain(removed.status()) })
  activationProof.response = activated
  activationProof.machineId = machineId
  await pairingToken.close()
  return { machineId, credential, hostname }
}

test("restored real machines stay unknown when observations beat the current list", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)
  const actors = await caseActors(["alice"])
  const { page } = await actors.asUser("alice", { viewport: { width: 1280, height: 900 } })
  const { machineId, hostname } = await activateRealMachine(page, caseResources)
  await page.goto("/c/me/machines")
  await expect(page.getByText(hostname, { exact: true })).toBeVisible()
  await expectPersistedClosure(page, actors.userId("alice"), [{ key: ["community", "machines"], containsId: machineId }])
  const stored = (await persistedQueries(page, actors.userId("alice"))).find(query => JSON.stringify(query.queryKey) === JSON.stringify(["community", "machines"]))?.data as { machines: Array<Record<string, unknown>> }
  expect(stored.machines.find(machine => machine.id === machineId)).not.toHaveProperty("status")
  expect(stored).not.toHaveProperty("machineCapacity")
  await page.goto("/")
  let releaseList!: () => void
  const listGate = new Promise<void>(resolve => { releaseList = resolve })
  caseResources.own(releaseList, async captured => { captured() })
  const listPattern = (url: URL) => url.pathname === "/api/community/machines" && url.searchParams.get("view") === "list"
  const observationPattern = (url: URL) => url.pathname === "/api/community/machines" && url.searchParams.get("view") === "observations"
  let observed: { machineCapacity: { onlineCount: number }; quotas: unknown[] } | undefined
  await page.route(listPattern, async route => { await listGate; await route.continue() })
  page.on("response", async response => { if (observationPattern(new URL(response.url())) && response.ok()) observed = await response.json() })
  try {
    const requested = page.waitForRequest(request => listPattern(new URL(request.url())))
    await page.goto("/c/me/friends")
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName("alook:restore:complete", "mark").length)).toBe(1)
    await page.getByRole("link", { name: "Machines", exact: true }).click()
    await requested
    await expect.poll(() => observed !== undefined).toBe(true)
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText(hostname, { exact: true }) })
    await expect(card).toHaveCount(1)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(card.getByText("Status unknown", { exact: true })).toBeVisible()
    await expect(card.getByText("Last seen unknown", { exact: true })).toBeVisible()
    await expect(card.getByText("Offline", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Machine usage loading", exact: true })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Machine usage loading", exact: true })).toHaveAttribute("aria-label", "Machine usage loading")
    const returned = page.waitForResponse(response => listPattern(new URL(response.url())) && response.ok())
    releaseList()
    const response = await returned
    const body = await response.json() as { machines: Array<{ id: string; status: string }> }
    const actual = body.machines.find(machine => machine.id === machineId)
    expect(actual).toBeDefined()
    await expect(card.getByText(actual!.status === "online" ? "Online" : "Offline", { exact: true })).toBeVisible()
    await expect(card.getByText("Status unknown", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /^Online machines: / })).toBeEnabled()
    await testInfo.attach("machines-observations-before-primary", { body: JSON.stringify({ machineId, actualStatus: actual!.status, observationOnlineCount: observed!.machineCapacity.onlineCount, persistedStatusAbsent: true }), contentType: "application/json" })
  } finally {
    releaseList()
    await page.unroute(listPattern)
  }
})

async function holdFirstRealRead(page: Page, match: (url: URL) => boolean, resources: CaseResources) {
  let release!: () => void
  let settled!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { settled = resolve })
  let original: Request | undefined
  let captured: { status: number; body: unknown } | undefined
  let failure: unknown
  let aborted = false
  page.on("requestfailed", request => {
    if (request === original && request.failure()?.errorText.includes("ERR_ABORTED")) aborted = true
  })
  await page.route(match, async route => {
    if (original || route.request().method() !== "GET") { await route.continue(); return }
    original = route.request()
    try {
      const response = await route.fetch()
      captured = { status: response.status(), body: await response.json() }
      await gate
      await route.fulfill({ response })
    } catch (error) { failure = error }
    finally { settled() }
  })
  const owned = resources.own(match, async pattern => {
    release()
    if (original) await finished
    await page.unroute(pattern)
    if (failure && !aborted) throw failure
  })
  return { captured: () => captured, release, close: () => owned.close(), aborted: () => aborted }
}

type NativeMachineSocket = {
  readonly readyState: number
  send: (body: string) => void
  close: () => void
  once(event: "open" | "close", listener: () => void): void
  once(event: "error", listener: (error: Error) => void): void
  on(event: "message", listener: (body: { toString(): string }) => void): void
  off(event: "message", listener: (body: { toString(): string }) => void): void
}

function connectRealMachine(credential: string, resources: CaseResources) {
  const requireFromDaemon = createRequire(resolve(REPO_ROOT, "src/daemon/package.json"))
  const Ws = requireFromDaemon("ws") as { WebSocket: new (url: string, options: { headers: Record<string, string> }) => NativeMachineSocket }
  const socket = new Ws.WebSocket(MACHINE_WS_URL.replace(/^http/, "ws"), { headers: { Authorization: `Bearer ${credential}` } })
  let heartbeatAcks = 0
  let protocolFailure: Error | undefined
  const onMessage = (body: { toString(): string }) => {
    try {
      const parsed = HostCommandSchema.safeParse(JSON.parse(body.toString()))
      if (parsed.success && parsed.data.type === "machine:heartbeat") {
        socket.send(JSON.stringify({ type: "machine_heartbeat_ack", nonce: parsed.data.nonce }))
        heartbeatAcks += 1
      }
    } catch { protocolFailure = new Error("Machine socket control response failed") }
  }
  socket.on("message", onMessage)
  const owned = resources.own(socket, async captured => {
    captured.off("message", onMessage)
    await new Promise<void>(resolveClose => {
      if (captured.readyState === 3) { resolveClose(); return }
      captured.once("close", resolveClose)
      captured.close()
    })
    if (protocolFailure) throw protocolFailure
  })
  const opened = new Promise<void>((resolveOpen, reject) => { socket.once("open", resolveOpen); socket.once("error", reject) })
  return { socket, opened, close: () => owned.close(), heartbeatAcks: () => heartbeatAcks }
}

test("real machine status, removal and creation retire an older list response", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)
  const actors = await caseActors(["alice"])
  const { page, context } = await actors.asUser("alice", { viewport: { width: 1280, height: 900 } })
  const first = await activateRealMachine(page, caseResources)
  const held = await holdFirstRealRead(page, url => url.pathname === "/api/community/machines" && url.searchParams.get("view") === "list", caseResources)
  const proxy = await proxyCommunityWebSockets(context)
  try {
    await page.goto("/c/me/friends")
    await expect.poll(() => held.captured() !== undefined).toBe(true)
    expect(held.captured()?.status).toBe(200)
    const original = held.captured()!.body as { machines: Array<{ id: string; status: string }> }
    expect(original.machines.map(machine => machine.id)).toEqual([first.machineId])
    expect(original.machines[0].status).toBe("offline")
    await expect.poll(() => proxy.connectionFrames.some(frame => frame.type === "auth.ok")).toBe(true)
    const connection = connectRealMachine(first.credential, caseResources)
    await connection.opened
    connection.socket.send(JSON.stringify(HostReadyMessageSchema.parse({ type: "ready", runtimeReport: [{ id: "pi", status: "healthy" }], capabilities: [CONTROL_HEARTBEAT_CAPABILITY], runningAgents: [], hostname: first.hostname, platform: "linux", arch: "x64", daemonVersion: (JSON.parse(readFileSync(resolve(REPO_ROOT, "src/daemon/package.json"), "utf8")) as { version: string }).version })))
    await expect.poll(() => proxy.frames.some(frame => frame.type === "community:machine.status" && frame.machineId === first.machineId && frame.status === "online")).toBe(true)
    const online = await page.request.get("/api/community/machines?view=list")
    expect(online.status()).toBe(200)
    expect((await online.json()).machines).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.machineId, status: "online" })]))
    await connection.close()
    await expect.poll(() => proxy.frames.some(frame => frame.type === "community:machine.status" && frame.machineId === first.machineId && frame.status === "offline")).toBe(true)
    const removed = await page.request.delete(`/api/community/machines/${first.machineId}`)
    expect(removed.status()).toBe(204)
    await expect.poll(() => proxy.frames.some(frame => frame.type === "community:machine.removed" && frame.machineId === first.machineId)).toBe(true)
    const second = await activateRealMachine(page, caseResources)
    await expect.poll(() => proxy.frames.some(frame => frame.type === "community:machine.created" && (frame.machine as { id?: string } | undefined)?.id === second.machineId)).toBe(true)
    await page.getByRole("link", { name: "Machines", exact: true }).click()
    await expect(page.getByText(second.hostname, { exact: true })).toBeVisible()
    const current = await page.request.get("/api/community/machines?view=list")
    expect(current.status()).toBe(200)
    expect((await current.json()).machines.map((machine: { id: string }) => machine.id)).toEqual([second.machineId])
    held.release()
    await held.close()
    await expect(page.getByText(second.hostname, { exact: true })).toHaveCount(1)
    await expect(page.getByText(first.hostname, { exact: true })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "No machines yet", exact: true })).toHaveCount(0)
    await testInfo.attach("real-machine-ws-before-old-list", { body: JSON.stringify({ originalIds: original.machines.map(machine => machine.id), currentIds: [second.machineId], originalRequestAborted: held.aborted(), heartbeatAcks: connection.heartbeatAcks(), events: proxy.frames.filter(frame => frame.type.startsWith("community:machine.")).map(frame => ({ type: frame.type, machineId: frame.machineId ?? (frame.machine as { id?: string } | undefined)?.id, status: frame.status })) }), contentType: "application/json" })
  } finally { await held.close() }
})

for (const lateSource of ["query", "idb"] as const) {
  test(`a real account replacement in the same document rejects old-account ${lateSource} completion`, async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const { seedDm, seedDmMessage } = actors.seed
    const aliceDm = await seedDm("alice", actors.userId("carol"))
    const aliceMessage = await seedDmMessage("carol", aliceDm, `Alice private ${Date.now()}`)
    const bobDm = await seedDm("bob", actors.userId("carol"))
    const bobBody = `Bob private ${Date.now()}`
    const bobMessage = await seedDmMessage("carol", bobDm, bobBody)
    const { page, context } = await actors.asNaturalUser("alice", { width: 1280, height: 900 })
    await page.goto(`${WEB_URL}/c/me/${aliceDm}`)
    await expect(page.getByTestId(tid.message(aliceMessage))).toBeVisible()
    await expectPersistedClosure(page, actors.userId("alice"), [{ key: ["community", "db", actors.userId("alice"), "messages"], containsId: aliceMessage }])
    await page.goto(`${WEB_URL}/`)
    const held = lateSource === "query" ? await holdFirstRealRead(page, url => url.pathname === "/api/community/users/me/dms", caseResources) : undefined
    if (lateSource === "idb") {
      await holdOriginalPersistedRead(page, actors.userId("alice"), aliceMessage, bobMessage)
      caseResources.own(page, releaseOriginalPersistedRead)
      caseResources.own(page, captured => captureOriginalPersistedReadDiagnostics(captured, testInfo, "account-idb"))
    }
    try {
      await page.goto(`${WEB_URL}/c/me/${aliceDm}`, { waitUntil: "commit" })
      const documentId = await page.evaluate(() => {
        const id = crypto.randomUUID()
        Reflect.set(window, "__217OriginalDocument", id)
        const state = { documentId: id, checkpoint: 0, events: [] as Array<{ hidden: boolean; visibility: string; trusted: boolean; at: number }> }
        Reflect.set(window, "__217NaturalVisibility", state)
        document.addEventListener("visibilitychange", event => {
          state.events.push({ hidden: document.hidden, visibility: document.visibilityState, trusted: event.isTrusted, at: performance.now() })
        })
        return id
      })
      if (held) await expect(page.getByTestId(tid.message(aliceMessage))).toBeVisible()
      else await expect(page.getByTestId(tid.message(aliceMessage))).toHaveCount(0)
      if (held) {
        await expect.poll(() => held.captured() !== undefined).toBe(true)
        expect(held.captured()?.status).toBe(200)
        expect(containsPersistedId(held.captured()?.body, aliceDm)).toBe(true)
      } else await expect.poll(() => page.evaluate(() => {
        const state = Reflect.get(window, "__217DiskRead") as { held: number; oldPresent: boolean; newPresent: boolean }
        return { held: state.held, oldPresent: state.oldPresent, newPresent: state.newPresent }
      })).toEqual({ held: 1, oldPresent: true, newPresent: false })
      const bobSession = await fetch(`${WEB_URL}/api/auth/get-session`, { headers: { Cookie: actors.sessionCookie("bob"), Origin: WEB_URL } })
      expect(bobSession.status).toBe(200)
      const bobIdentity = await bobSession.json() as { user: { id: string; email: string } }
      expect(bobIdentity.user.id).toBe(actors.userId("bob"))
      const login = await page.request.post(`${WEB_URL}/api/auth/sign-in/email`, { headers: { Origin: WEB_URL }, data: { email: bobIdentity.user.email, password: DEV_PASSWORD } })
      expect(login.status()).toBe(200)
      expect((await login.json()).user.id).toBe(actors.userId("bob"))
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible")
      await page.evaluate(() => {
        const state = Reflect.get(window, "__217NaturalVisibility") as { checkpoint: number; events: unknown[] }
        state.checkpoint = state.events.length
      })
      const away = await context.newPage()
      const ownedAway = caseResources.own(away, async captured => { await captured.close() })
      caseResources.own(page, async captured => {
        if (captured.isClosed()) {
          await testInfo.attach(`account-visibility-${lateSource}`, { body: JSON.stringify({ pageClosedBeforeCapture: true }), contentType: "application/json" })
          return
        }
        const observed = await captured.evaluate(() => {
          const state = Reflect.get(window, "__217NaturalVisibility") as { documentId: string; checkpoint: number; events: unknown[] } | undefined
          return { sameDocument: state?.documentId === Reflect.get(window, "__217OriginalDocument"), checkpoint: state?.checkpoint,
            current: document.visibilityState, events: state?.events }
        })
        await testInfo.attach(`account-visibility-${lateSource}`, { body: JSON.stringify(observed), contentType: "application/json" })
      })
      await away.bringToFront()
      await expect.poll(() => page.evaluate(() => {
        const state = Reflect.get(window, "__217NaturalVisibility") as { checkpoint: number; events: Array<{ hidden: boolean; visibility: string; trusted: boolean }> }
        return document.hidden && state.events.slice(state.checkpoint).some(event => event.hidden && event.visibility === "hidden" && event.trusted)
      })).toBe(true)
      await page.waitForTimeout(5_100)
      const refreshedSession = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/get-session" && response.ok())
      void refreshedSession.catch(() => {})
      await page.bringToFront()
      await expect.poll(() => page.evaluate(() => {
        const state = Reflect.get(window, "__217NaturalVisibility") as { checkpoint: number; events: Array<{ hidden: boolean; visibility: string; trusted: boolean }> }
        const events = state.events.slice(state.checkpoint)
        const hidden = events.findIndex(event => event.hidden && event.visibility === "hidden" && event.trusted)
        return document.visibilityState === "visible" && hidden >= 0
          && events.slice(hidden + 1).some(event => !event.hidden && event.visibility === "visible" && event.trusted)
      })).toBe(true)
      expect((await (await refreshedSession).json()).user.id).toBe(actors.userId("bob"))
      await expect(page.getByTestId(tid.userBarName)).toHaveText(actors.userName("bob"))
      expect(await page.evaluate(() => Reflect.get(window, "__217OriginalDocument"))).toBe(documentId)
      await expect(page.getByTestId(tid.dmRow(bobDm))).toBeVisible()
      await page.getByTestId(tid.dmRow(bobDm)).click()
      await expect(page.getByTestId(tid.message(bobMessage)).getByText(bobBody, { exact: true })).toBeVisible()
      let diskRetirement: Awaited<ReturnType<typeof retiredAccountDiskState>> | undefined
      let originalRestoreRetirement: unknown
      if (held) { held.release(); await held.close() }
      else {
        await releaseOriginalPersistedRead(page)
        await expect.poll(() => page.evaluate(() => (Reflect.get(window, "__217DiskRead") as { retirementCheck: unknown }).retirementCheck)).toEqual({ complete: true, accountChanged: true, scopeChanged: true, channelsReset: true })
        originalRestoreRetirement = await page.evaluate(() => (Reflect.get(window, "__217DiskRead") as { retirementCheck: unknown }).retirementCheck)
        diskRetirement = await retiredAccountDiskState(page, actors.userId("alice"), aliceDm)
        expect(diskRetirement).toEqual({ payloadAbsent: true, applicationPayloadAbsent: true, accountEpochPresent: true, scopeEpochPresent: true, channelsReset: true, oldChannelFenceAbsent: true })
        await expectPersistedClosure(page, actors.userId("bob"), [{ key: ["community", "db", actors.userId("bob"), "messages"], containsId: bobMessage }])
        const bobStored = await persistedQueries(page, actors.userId("bob"))
        expect(containsPersistedId(bobStored, aliceMessage)).toBe(false)
      }
      await expect(page.getByTestId(tid.userBarName)).toHaveText(actors.userName("bob"))
      await expect(page.getByTestId(tid.message(bobMessage))).toHaveCount(1)
      await expect(page.getByTestId(tid.message(aliceMessage))).toHaveCount(0)
      await expect(page.getByTestId(tid.dmRow(aliceDm))).toHaveCount(0)
      await expect(page).toHaveURL(new RegExp(`/c/me/${bobDm}$`))
      expect(await page.evaluate(() => Reflect.get(window, "__217OriginalDocument"))).toBe(documentId)
      await ownedAway.close()
      await testInfo.attach(`account-replaced-before-${lateSource}`, { body: JSON.stringify({ oldViewerId: actors.userId("alice"), currentViewerId: actors.userId("bob"), lateSource, documentPreserved: true, currentMessageId: bobMessage, retiredMessageId: aliceMessage, queryAborted: held?.aborted(), originalRestoreRetirement, diskRetirement }), contentType: "application/json" })
    } finally {
      if (held) await held.close()
      else await releaseOriginalPersistedRead(page)
    }
  })
}
