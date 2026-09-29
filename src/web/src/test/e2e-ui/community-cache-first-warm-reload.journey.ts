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

const communityApiPattern = "**/api/community/**"

async function holdCommunityReads(page: Page) {
  let releaseReads!: () => void
  const readsGate = new Promise<void>((resolve) => { releaseReads = resolve })
  let heldReads = 0

  await page.route(communityApiPattern, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    heldReads += 1
    await readsGate
    await route.continue()
  })

  return {
    heldReadCount: () => heldReads,
    releaseAndRemove: async () => {
      releaseReads()
      await page.unrouteAll({ behavior: "wait" })
    },
  }
}

type CommunityDbProbeSnapshot = {
  collectionStatus: string
  collectionSize: number
  collectionRowIds: string[]
  readiness: string
  restored: boolean
  persistence: null | { rowKeys: string[]; schemaVersion: number }
  channelCollectionStatus: string
  channelCollectionSize: number
  channelCollectionRowIds: string[]
  channelReadiness: string
  channelRestored: boolean
  channelPersistence: null | { rowKeys: string[]; schemaVersion: number }
  messageCollectionStatus: string
  messageCollectionSize: number
  messageCollectionRows: Array<{ id: string; channelId: string }>
  messageReadiness: string
  messageRestored: boolean
  messagePersistence: null | { rowKeys: string[]; schemaVersion: number }
  readStateCollectionStatus: string
  readStateCollectionSize: number
  readStateRows: Array<{
    channelId: string
    lastReadMessageId?: string | null
    lastReadSeq: number
  }>
  readStateReadiness: string
  readStateRestored: boolean
  navigationProof: null | { target: { channelId: string }; status: string }
}

async function communityDbProbe(page: Page): Promise<CommunityDbProbeSnapshot | null> {
  return page.evaluate(async () => {
    const probe = Reflect.get(window, "__ALOOK_COMMUNITY_DB_PROBE__") as undefined | {
      snapshot: () => Promise<CommunityDbProbeSnapshot>
    }
    return probe ? probe.snapshot() : null
  })
}

async function writeServerThroughCommunityDbProbe(
  page: Page,
  row: {
    id: string
    position: number
    name: string
    discriminator: string
    description: string
    ownerId: string
    icon: string | null
    official: boolean
    isOwner: boolean
    unread: boolean
    mentions: number
    detailComplete: boolean
  },
) {
  await page.evaluate(async (server) => {
    const probe = Reflect.get(window, "__ALOOK_COMMUNITY_DB_PROBE__") as undefined | {
      writeServer: (value: typeof server) => Promise<void>
    }
    if (!probe) throw new Error("community DB probe is unavailable")
    await probe.writeServer(server)
  }, row)
}

async function expectDurableServerRow(page: Page, serverId: string) {
  await expect.poll(async () => {
    const snapshot = await communityDbProbe(page)
    return snapshot ? {
      collectionHasRow: snapshot.collectionRowIds.includes(serverId),
      durableHasRow: snapshot.persistence?.rowKeys.includes(`s:${serverId}`) ?? false,
      readiness: snapshot.readiness,
      status: snapshot.collectionStatus,
    } : null
  }, { timeout: 20_000 }).toEqual({
    collectionHasRow: true,
    durableHasRow: true,
    readiness: "ready",
    status: "ready",
  })
}

async function expectHydratedServerRow(page: Page, serverId: string) {
  await expect.poll(async () => {
    const snapshot = await communityDbProbe(page)
    return snapshot ? {
      collectionHasRow: snapshot.collectionRowIds.includes(serverId),
      collectionSize: snapshot.collectionSize,
      durableHasRow: snapshot.persistence?.rowKeys.includes(`s:${serverId}`) ?? false,
      restored: snapshot.restored,
    } : null
  }, { timeout: 10_000 }).toMatchObject({
    collectionHasRow: true,
    collectionSize: expect.any(Number),
    durableHasRow: true,
    restored: true,
  })
}

async function expectDurableChannelRow(page: Page, channelId: string) {
  await expect.poll(async () => {
    const snapshot = await communityDbProbe(page)
    return snapshot ? {
      collectionHasRow: snapshot.channelCollectionRowIds.includes(channelId),
      durableHasRow: snapshot.channelPersistence?.rowKeys.includes(`s:${channelId}`) ?? false,
      readiness: snapshot.channelReadiness,
      status: snapshot.channelCollectionStatus,
    } : null
  }, { timeout: 20_000 }).toEqual({
    collectionHasRow: true,
    durableHasRow: true,
    readiness: "ready",
    status: "ready",
  })
}

async function expectHydratedChannelRow(page: Page, channelId: string) {
  await expect.poll(async () => {
    const snapshot = await communityDbProbe(page)
    return snapshot ? {
      collectionHasRow: snapshot.channelCollectionRowIds.includes(channelId),
      collectionSize: snapshot.channelCollectionSize,
      durableHasRow: snapshot.channelPersistence?.rowKeys.includes(`s:${channelId}`) ?? false,
      restored: snapshot.channelRestored,
    } : null
  }, { timeout: 10_000 }).toMatchObject({
    collectionHasRow: true,
    collectionSize: expect.any(Number),
    durableHasRow: true,
    restored: true,
  })
}

async function expectDurableMessageRow(page: Page, channelId: string, messageId: string) {
  await expect.poll(async () => {
    const snapshot = await communityDbProbe(page)
    return snapshot ? {
      collectionHasRow: snapshot.messageCollectionRows.some((row) => (
        row.id === messageId && row.channelId === channelId
      )),
      durableHasRow: snapshot.messagePersistence?.rowKeys.includes(`s:${messageId}`) ?? false,
      readiness: snapshot.messageReadiness,
      status: snapshot.messageCollectionStatus,
    } : null
  }, { timeout: 20_000 }).toEqual({
    collectionHasRow: true,
    durableHasRow: true,
    readiness: "ready",
    status: "ready",
  })
}

async function expectHydratedMessageInputs(page: Page, channelId: string, messageId: string) {
  await expect.poll(async () => {
    const snapshot = await communityDbProbe(page)
    return snapshot ? {
      collectionHasRow: snapshot.messageCollectionRows.some((row) => (
        row.id === messageId && row.channelId === channelId
      )),
      durableHasRow: snapshot.messagePersistence?.rowKeys.includes(`s:${messageId}`) ?? false,
      messageReadiness: snapshot.messageReadiness,
      messageRestored: snapshot.messageRestored,
      readStateReadiness: snapshot.readStateReadiness,
      readState: snapshot.readStateRows.find((row) => row.channelId === channelId) ?? null,
      navigationProof: snapshot.navigationProof,
    } : null
  }, { timeout: 10_000 }).toMatchObject({
    collectionHasRow: true,
    durableHasRow: true,
    messageReadiness: "ready",
    messageRestored: true,
    readStateReadiness: "ready",
    navigationProof: null,
  })
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

  const heldReads = await holdCommunityReads(page)
  let wsAttempts = 0
  await page.routeWebSocket((url) => url.pathname.endsWith("/user"), (socket) => {
    wsAttempts += 1
    void socket.close({ code: 1012, reason: "cache-first warm reload probe" })
  })

  try {
    await page.reload({ waitUntil: "commit" })
    await assertCachedContent()
    await expect.poll(heldReads.heldReadCount).toBeGreaterThan(0)
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
    await heldReads.releaseAndRemove()
  }
}

async function seedMessages(
  channelId: string,
  count: number,
  prefix: string,
) {
  const bodies: string[] = []
  for (let index = 0; index < count; index += 1) {
    const body = `${prefix} ${index + 1}`
    await seedMessage("alice", channelId, body)
    bodies.push(body)
  }
  return bodies
}

async function expectLeafReady(
  page: Page,
  serverId: string,
  channelId: string,
  body?: string,
) {
  await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/${channelId}$`), {
    timeout: 20_000,
  })
  await expect(page.getByTestId(tid.channelComposerShell)).toBeVisible({ timeout: 20_000 })
  if (body) await expect(page.getByText(body, { exact: true })).toBeVisible()
  await expect(page.locator(structuralLoadingSelectors.join(","))).toHaveCount(0)
}

async function expectInboxIndependentLeaf(
  page: Page,
  serverId: string,
  channelId: string,
  body?: string,
) {
  await page.getByTestId(tid.inboxTrigger).click()
  await expect(page.getByTestId(tid.userBarExtension)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/${channelId}$`))
  await expect(page.getByTestId(tid.channelComposerShell)).toBeAttached()
  if (body) await expect(page.getByText(body, { exact: true })).toBeAttached()
}

test.describe("direct and remembered leaf readiness", () => {
  for (const count of [0, 1, 30]) {
    test(`a fresh server root restores its remembered leaf with ${count} messages without Inbox`, async ({
      asUser,
    }) => {
      test.setTimeout(120_000)
      const suffix = `${count}-${Date.now().toString(36)}`
      const serverId = await seedServer("alice", `Remembered leaf ${suffix}`)
      await seedChannel("alice", serverId, `default-${suffix}`)
      const channelId = await seedChannel("alice", serverId, `remembered-${suffix}`)
      const bodies = await seedMessages(channelId, count, `remembered body ${suffix}`)
      const { page } = await asUser("alice")
      await page.addInitScript(([key, value]) => {
        localStorage.setItem(key, value)
      }, [`community:lastChannel:${serverId}`, channelId])

      await page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
      const expectedBody = bodies.at(-1)
      await expectLeafReady(page, serverId, channelId, expectedBody)
      await expectInboxIndependentLeaf(page, serverId, channelId, expectedBody)
    })
  }

  test("a direct channel click self-activates before Inbox and remains ready after it opens", async ({
    asUser,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now().toString(36)
    const serverId = await seedServer("alice", `Direct leaf ${suffix}`)
    const firstChannelId = await seedChannel("alice", serverId, `first-${suffix}`)
    const channelId = await seedChannel("alice", serverId, `direct-${suffix}`)
    const [body] = await seedMessages(channelId, 1, `direct body ${suffix}`)
    const { page } = await asUser("alice")

    await page.goto(`/c/channels/${serverId}/${firstChannelId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible({ timeout: 20_000 })
    await page.getByTestId(tid.channelRow(channelId)).click()
    await expectLeafReady(page, serverId, channelId, body)
    await expectInboxIndependentLeaf(page, serverId, channelId, body)
  })
})

test("a warm channel reload paints cached shell and messages before network", async ({ asUser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Warm channel ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `warm-${suffix}`)
  const body = `cached channel ${suffix}`
  const messageId = await seedMessage("alice", channelId, body)
  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expectOpfsPersistence(page)
  await expectDurableServerRow(page, serverId)
  await expectDurableChannelRow(page, channelId)
  await expectDurableMessageRow(page, channelId, messageId)

  await expectCacheFirstReload(page, async () => {
    await expectHydratedServerRow(page, serverId)
    await expectHydratedChannelRow(page, channelId)
    await expectHydratedMessageInputs(page, channelId, messageId)
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByText(body, { exact: false }).first()).toBeVisible()
  })
})

test("a collection-native write reaches a second tab through the browser coordinator", async ({
  asUser,
}) => {
  test.setTimeout(90_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `Coordinator source ${suffix}`)
  const channelId = await seedChannel("alice", serverId, `coordinator-${suffix}`)
  const { context, page } = await asUser("alice")
  const peer = await context.newPage()
  const href = `/c/channels/${serverId}/${channelId}`

  try {
    await Promise.all([page.goto(href), peer.goto(href)])
    await expect.poll(async () => (await communityDbProbe(page))?.readiness).toBe("ready")
    await expect.poll(async () => (await communityDbProbe(peer))?.readiness).toBe("ready")

    const directId = `coordinator-direct-${suffix}`
    await writeServerThroughCommunityDbProbe(page, {
      id: directId,
      position: 999_999,
      name: `Coordinator direct ${suffix}`,
      discriminator: "0001",
      description: "collection-native coordinator probe",
      ownerId: "e2e-coordinator",
      icon: null,
      official: false,
      isOwner: false,
      unread: false,
      mentions: 0,
      detailComplete: false,
    })

    await expect.poll(async () => {
      const snapshot = await communityDbProbe(peer)
      return snapshot?.collectionRowIds.filter((id) => id === directId).length ?? 0
    }, { timeout: 20_000 }).toBe(1)
  } finally {
    await peer.close()
  }
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

  const heldReads = await holdCommunityReads(page)

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
    await expect.poll(heldReads.heldReadCount).toBeGreaterThan(0)
  } finally {
    await heldReads.releaseAndRemove()
  }
  await expect(page.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
