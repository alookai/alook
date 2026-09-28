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
}

const structuralLoadingSelectors = [
  '[aria-label="Loading community"]',
  "[data-message-list-skeleton]",
  `[data-testid^="${tid.pendingMain("")}"]`,
  `[data-testid="${tid.initialRailPending}"]`,
  `[data-testid="${tid.dmSidebarPending}"]`,
  `[data-testid^="${tid.channelSidebarPending("")}"]`,
]

async function expectOpfsPersistence(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle("alook-tanstack-db-v1.sqlite")
      return (await handle.getFile()).size
    } catch {
      return 0
    }
  }), { timeout: 20_000 }).toBeGreaterThan(0)
}

async function expectCacheFirstReload(
  page: Page,
  assertCachedContent: () => Promise<void>,
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
    const readCapture = () => page.evaluate((): ReloadCapture | null => {
      const state = (window as unknown as {
        __cacheFirstReload?: {
          customBootstrapSeen: boolean
          skeletonSeen: boolean
          firstSkeleton: string | null
        }
      }).__cacheFirstReload
      if (!state) return null
      return {
        customBootstrapSeen: state.customBootstrapSeen,
        skeletonSeen: state.skeletonSeen,
        firstSkeleton: state.firstSkeleton,
      }
    })
    await expect.poll(readCapture, { timeout: 10_000 }).not.toBeNull()
    const capture = await readCapture()
    if (!capture) throw new Error("warm reload capture is unavailable")
    expect(capture.customBootstrapSeen).toBe(false)
    await expect(page.locator(structuralLoadingSelectors.join(","))).toHaveCount(0)
    return capture
  } finally {
    releaseReads()
    await page.unroute("**/api/community/**")
  }
}

test("a warm channel reload paints cached shell and messages before network", async ({ asUser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Warm channel ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `warm-${suffix}`)
  const body = `cached channel ${suffix}`
  await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectOpfsPersistence(page)

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByText(body, { exact: false }).first()).toBeVisible()
  })
})

test("a warm DM reload paints cached identity and messages before network", async ({ asUser }) => {
  test.setTimeout(120_000)
  const dmId = await seedDm("alice", userId("bob"))
  const body = `cached dm ${Date.now()}`
  await seedDmMessage("bob", dmId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/me/${dmId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectOpfsPersistence(page)

  await expectCacheFirstReload(page, async () => {
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(body, { exact: false }).first()).toBeVisible()
  })
})

test("a warm desktop split reload paints both cached panes before network", async ({ asUser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Warm split ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `split-${suffix}`)
  const parentBody = `cached parent ${suffix}`
  const openerId = await seedMessage("alice", channelId, parentBody)
  const threadId = await seedThread("alice", openerId, `thread-${suffix}`)
  const threadBody = `cached thread ${suffix}`
  await seedMessage("alice", threadId, threadBody)
  const { page } = await asUser("alice", { viewport: { width: 1280, height: 900 } })
  await page.goto(`/c/channels/${serverId}/${threadId}`)
  await expect(page.getByTestId(tid.threadSplit)).toHaveAttribute("data-layout", "split", {
    timeout: 20_000,
  })
  await expect(page.getByText(threadBody, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectOpfsPersistence(page)

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

/* istanbul ignore next -- retained true-cold Chromium journey */
test("a true-cold channel load keeps the session frame before localized skeletons", async ({ asUser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Cold control ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `cold-${suffix}`)
  const body = `network channel ${suffix}`
  await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.addInitScript((loadingSelectors) => {
    const state = {
      customBootstrapSeen: false,
      localizedSkeletonSeen: false,
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
      if (document.querySelector(loadingSelectors.join(","))) {
        state.localizedSkeletonSeen = true
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

  try {
    await page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
    await expect.poll(() => page.evaluate(() => {
      return (window as unknown as {
        __cacheFirstColdControl?: {
          customBootstrapSeen: boolean
          localizedSkeletonSeen: boolean
          sessionFrameSeen: boolean
        }
      }).__cacheFirstColdControl
    })).toMatchObject({
      customBootstrapSeen: false,
      localizedSkeletonSeen: true,
      sessionFrameSeen: true,
    })
    await expect.poll(() => heldReads).toBeGreaterThan(0)
  } finally {
    releaseReads()
    await page.unroute("**/api/community/**")
  }
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
