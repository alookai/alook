import type { Page } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import {
  seedChannel,
  seedDm,
  seedDmMessage,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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
  }), `alook:qc:v2:${viewerId}:client`)
}

function containsPersistedId(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsPersistedId(entry, id))
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return record.id === id || Object.values(record).some((entry) => containsPersistedId(entry, id))
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
    const rawMessageQuery = queries.find(({ queryKey }) => (
      queryKey[0] === "community"
      && (queryKey[1] === "channel" || queryKey[1] === "dm")
      && queryKey[3] === "messages"
    ))
    if (rawMessageQuery) {
      failures.push(`unexpected raw message key ${JSON.stringify(rawMessageQuery.queryKey)}`)
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
  assertCachedContent: () => Promise<void>,
): Promise<ReloadCapture> {
  const structuralLoadingSelectors = [
    '[aria-label="Loading community"]',
    "[data-message-list-skeleton]",
    `[data-testid^="${tid.pendingMain("")}"]`,
    `[data-testid="${tid.initialRailPending}"]`,
    `[data-testid="${tid.dmSidebarPending}"]`,
    `[data-testid^="${tid.channelSidebarPending("")}"]`,
  ]
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
  let wsAttempts = 0
  await page.routeWebSocket((url) => url.pathname.endsWith("/user"), (socket) => {
    wsAttempts += 1
    void socket.close({ code: 1012, reason: "cache-first warm reload probe" })
  })

  try {
    await page.reload({ waitUntil: "commit" })
    await assertCachedContent()
    await expect.poll(() => heldReads).toBeGreaterThan(0)
    await expect.poll(() => wsAttempts).toBeGreaterThan(0)
    const capture = await page.evaluate(() => {
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
        throw new Error("warm reload restore lifecycle marks are incomplete")
      }
      return {
        customBootstrapSeen: state?.customBootstrapSeen === true,
        skeletonSeen: state?.skeletonSeen === true,
        firstSkeleton: state?.firstSkeleton ?? null,
        marks: marks as ReloadCapture["marks"],
      }
    })
    expect(capture.customBootstrapSeen).toBe(false)
    expect(capture.skeletonSeen, capture.firstSkeleton ?? "warm reload regional skeleton").toBe(true)
    expect(capture.marks.complete).toBeGreaterThanOrEqual(capture.marks.start)
    expect(capture.marks.cached).toBeGreaterThanOrEqual(capture.marks.complete)
    expect(capture.marks.stable).toBeGreaterThanOrEqual(capture.marks.cached)
    return capture
  } finally {
    releaseReads()
    await page.unroute("**/api/community/**")
  }
}

test("a warm channel reload replaces regional skeletons with cached shell and messages", async ({ asUser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Warm channel ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `warm-${suffix}`)
  const body = `cached channel ${suffix}`
  const messageId = await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectPersistedClosure(page, userId("alice"), [
    { key: ["community", "servers"] },
    { key: ["community", "folders"] },
    { key: ["community", "db", userId("alice"), "channels"], containsId: channelId },
    { key: ["community", "servers", serverId], containsId: channelId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: messageId },
  ])

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByText(body, { exact: false }).first()).toBeVisible()
  })
})

test("a warm DM reload replaces regional skeletons with cached identity and messages", async ({ asUser }) => {
  test.setTimeout(120_000)
  const dmId = await seedDm("alice", userId("bob"))
  const body = `cached dm ${Date.now()}`
  const messageId = await seedDmMessage("bob", dmId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/me/${dmId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectPersistedClosure(page, userId("alice"), [
    { key: ["community", "servers"] },
    { key: ["community", "folders"] },
    { key: ["community", "dms"], containsId: dmId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: messageId },
  ])

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(body, { exact: false }).first()).toBeVisible()
  })
})

test("a warm desktop split reload replaces regional skeletons in both cached panes", async ({ asUser }) => {
  test.setTimeout(120_000)
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
    { key: ["community", "servers"] },
    { key: ["community", "folders"] },
    { key: ["community", "db", userId("alice"), "channels"], containsId: channelId },
    { key: ["community", "servers", serverId], containsId: channelId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: openerId },
    { key: ["community", "db", userId("alice"), "messages"], containsId: threadMessageId },
  ])

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split", {
      timeout: 10_000,
    })
    await expect(page.getByTestId(tid.threadSplitParent).getByText(parentBody, { exact: false }))
      .toBeVisible()
    await expect(page.getByTestId(tid.threadSplitPanel).getByText(threadBody, { exact: false }))
      .toBeVisible()
  })
})

test("a true-cold channel load reuses localized skeletons without a custom bootstrap", async ({ asUser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Cold control ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `cold-${suffix}`)
  const body = `network channel ${suffix}`
  await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.goto("/")
  await clearQueryPersistence(page)
  await page.addInitScript(() => {
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
        && document.querySelector('[data-slot="skeleton"]')
      ) state.localizedSkeletonAfterRestore = true
    }
    new MutationObserver(inspect).observe(document, { childList: true, subtree: true })
    inspect()
  })

  let releaseReads!: () => void
  const readsGate = new Promise<void>((resolve) => { releaseReads = resolve })
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
  } finally {
    releaseReads()
    await page.unroute("**/api/community/**")
  }
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
