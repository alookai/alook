import type { Page, Request, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { expectConversationReady, observeConversationTransport } from "./_fixtures/conversation-readiness"
import { captureReadyConversation, runRenderedNavigation, type RenderedContract } from "./_fixtures/rendered-navigation"

async function holdRoute(page: Page, pathname: string) {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const requests: Array<{ pathname: string; query: string; rsc: boolean; prefetch: boolean; heldAt: number }> = []
  const pattern = `**${pathname}**`
  const handler = async (route: Route) => {
    const url = new URL(route.request().url()); const headers = route.request().headers()
    requests.push({ pathname: url.pathname, query: url.search, rsc: headers.rsc === "1", prefetch: !!(headers["next-router-prefetch"] || headers["next-router-segment-prefetch"]), heldAt: Date.now() })
    await gate; await route.continue()
  }
  await page.route(pattern, handler)
  let releasedAt: number | null = null
  return {
    held: () => requests.length,
    snapshot: () => ({ pathname, pattern, requests, releasedAt, role: "matched transport diagnostic, not a structural commit barrier" }),
    release: async () => { if (releasedAt !== null) return; releasedAt = Date.now(); releaseGate(); await page.unroute(pattern, handler) },
  }
}

function channelHeader(page: Page, name: string) {
  return page.getByRole("banner").getByText(name, { exact: true })
}

test("community detail reaches target consumer readiness and keeps list surfaces stable", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Frame Gate ${stamp}`)
  const channelAName = `frame-a-${stamp}`; const channelBName = `frame-b-${stamp}`
  const channelA = await seedChannel("alice", serverId, channelAName)
  const channelB = await seedChannel("alice", serverId, channelBName)
  const { page } = await asUser("alice")
  const transport = observeConversationTransport(page)
  const gates: Awaited<ReturnType<typeof holdRoute>>[] = []
  const hold = async (path: string) => { const gate = await holdRoute(page, path); gates.push(gate); return gate }
  const mutations: string[] = []
  const readOnlyPostPaths = new Set(["/api/community/messages/batch", "/api/community/messages/tags/batch", "/api/community/channels/participants/batch"])
  const onRequest = (request: Request) => {
    const method = request.method(); const pathname = new URL(request.url()).pathname
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !(method === "POST" && readOnlyPostPaths.has(pathname))) mutations.push(`${method} ${pathname}`)
  }
  const root = `/c/channels/${serverId}`; const pathA = `${root}/${channelA}`; const pathB = `${root}/${channelB}`
  const scope = `server:${serverId}`
  try {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(pathA)
    await expect(channelHeader(page, channelAName)).toBeVisible({ timeout: 30_000 })
    await expectConversationReady(page, { pathname: pathA, serverId, channelId: channelA, kind: "text", empty: true }, testInfo)
    page.on("request", onRequest)
    const leafGate = await hold(pathB)
    await runRenderedNavigation(page, testInfo, "rendered-target-transition", `[data-testid="${tid.channelRow(channelB)}"]`, {
      paths: [pathA, pathB], finalPath: pathB, channelId: channelB, header: channelBName, scopes: [scope], finalScope: scope, pendingKind: "server-conversation", subtype: "text",
    }, async () => {
      try { await page.getByTestId(tid.channelRow(channelB)).click({ noWaitAfter: true }); await expect.poll(leafGate.held).toBeGreaterThan(0) }
      finally { await leafGate.release() }
      const target = { pathname: pathB, serverId, channelId: channelB, kind: "text" as const, empty: true }
      await expectConversationReady(page, target, testInfo)
      await captureReadyConversation(page, target, testInfo, "qualified-B")
    })
    await expect(channelHeader(page, channelAName)).toHaveCount(0)
    await expect(page.locator(`[data-slot="community-conversation-surface"][data-channel-id="${channelA}"]`)).toHaveCount(0)
    await expect(channelHeader(page, channelBName)).toBeVisible()
    transport.assertHealthy()

    await page.setViewportSize({ width: 390, height: 844 })
    const rootGate = await hold(root)
    await runRenderedNavigation(page, testInfo, "mobile-Back-root", 'button[aria-label="Back"]', {
      paths: [pathB, root], finalPath: root, scopes: [scope], finalScope: scope, header: channelBName,
      channelId: channelB, listStates: ["server"], finalListState: "server", stationary: true,
    }, async () => {
      try { await page.getByRole("banner").getByRole("button", { name: "Back" }).click({ noWaitAfter: true }); await expect.poll(rootGate.held).toBeGreaterThan(0) }
      finally { await rootGate.release() }
      await expect.poll(() => new URL(page.url()).pathname).toBe(root)
      await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible()
    })
    await runRenderedNavigation(page, testInfo, "desktop-list-restore", null, {
      paths: [root, pathB], finalPath: pathB, scopes: [scope], finalScope: scope, channelId: channelB, header: channelBName,
      listStates: ["server"], actionKind: "programmatic",
    }, async () => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
      await expect(channelHeader(page, channelBName)).toBeVisible()
      await expectConversationReady(page, { pathname: pathB, serverId, channelId: channelB, kind: "text", empty: true }, testInfo)
    })

    await page.goto("/c/me/friends")
    await expect(page.getByPlaceholder("Search friends")).toBeVisible({ timeout: 30_000 })
    const machinesGate = await hold("/c/me/machines")
    await runRenderedNavigation(page, testInfo, "Friends-to-Machines", '#sidebar button:has(svg.lucide-monitor)', {
      paths: ["/c/me/friends", "/c/me/machines"], finalPath: "/c/me/machines", scopes: [], listStates: ["friends", "friends-pending", "machines", "machines-pending"], finalListState: "machines",
    }, async () => {
      try { await page.getByRole("button", { name: "Machines", exact: true }).click({ noWaitAfter: true }); await expect.poll(machinesGate.held).toBeGreaterThan(0) }
      finally { await machinesGate.release() }
      await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
      await expect(page.getByTestId(tid.machinePairOpen)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")
      await expect(page.getByPlaceholder("Search friends")).toHaveCount(0)
    })
    expect(mutations).toEqual([]); transport.assertHealthy()
  } finally {
    for (const gate of gates) await gate.release()
    page.off("request", onRequest)
    await testInfo.attach("held-routes", { body: JSON.stringify(gates.map((gate) => gate.snapshot())), contentType: "application/json" })
    await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" }); transport.stop()
  }
})

test("mobile route commits stay stationary while sidebar identity survives same-server history", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const stamp = Date.now(); const serverId = await seedServer("alice", `Mobile frame ${stamp}`)
  const fastName = `fast-${stamp}`; const pendingName = `pending-${stamp}`
  const fastChannel = await seedChannel("alice", serverId, fastName); const pendingChannel = await seedChannel("alice", serverId, pendingName)
  const { page } = await asUser("alice")
  const transport = observeConversationTransport(page)
  const root = `/c/channels/${serverId}`; const fastPath = `${root}/${fastChannel}`; const pendingPath = `${root}/${pendingChannel}`; const scope = `server:${serverId}`
  const fastRow = page.getByTestId(tid.channelRow(fastChannel)); const sidebarScroll = page.getByTestId(tid.channelSidebarScroll)
  const gates: Awaited<ReturnType<typeof holdRoute>>[] = []
  const identity = async () => {
    expect(await page.evaluate(({ scrollId, rowId }) => {
      const state = window as typeof window & { __retainedSidebar?: { scroll: Element; row: Element } }
      return state.__retainedSidebar?.scroll === document.querySelector(`[data-testid="${scrollId}"]`)
        && state.__retainedSidebar.row === document.querySelector(`[data-testid="${rowId}"]`)
    }, { scrollId: tid.channelSidebarScroll, rowId: tid.channelRow(fastChannel) })).toBe(true)
    expect(await sidebarScroll.evaluate((node) => (node as HTMLElement & { __e2eIdentity?: string }).__e2eIdentity)).toBe("stable")
    expect(await fastRow.evaluate((node) => (node as HTMLElement & { __e2eDndOwner?: string }).__e2eDndOwner)).toBe("stable")
  }
  const ready = async (channelId: string) => expectConversationReady(page, { pathname: `${root}/${channelId}`, serverId, channelId, kind: "text", empty: true, layout: "mobile-detail" }, testInfo)
  const list = async (checkIdentity = true) => { await expect.poll(() => new URL(page.url()).pathname).toBe(root); await expect(fastRow).toBeVisible(); await expect(page.locator('[data-community-mobile-surface="list"]')).toBeVisible(); if (checkIdentity) await identity() }
  const detailContract = (source: string, channelId: string, name: string): RenderedContract => ({ paths: [source, `${root}/${channelId}`], finalPath: `${root}/${channelId}`, scopes: [scope], finalScope: scope, channelId, header: name, pendingKind: "server-conversation", subtype: "text", stationary: true, ...(source === root ? { sourceListPath: root } : {}) })
  const listContract = (source: string, channelId?: string, name?: string): RenderedContract => ({ paths: [source, root], finalPath: root, scopes: [scope], finalScope: scope, allowedRows: [fastChannel], channelId, header: name, listStates: ["server"], finalListState: "server", stationary: true })
  try {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(root); await expect(fastRow).toBeVisible({ timeout: 30_000 })
    await page.evaluate(({ scrollId, rowId }) => {
      const scroll = document.querySelector(`[data-testid="${scrollId}"]`)!; const row = document.querySelector(`[data-testid="${rowId}"]`)!
      ;(window as typeof window & { __retainedSidebar?: { scroll: Element; row: Element } }).__retainedSidebar = { scroll, row }
      ;(scroll as HTMLElement & { __e2eIdentity?: string }).__e2eIdentity = "stable"; (row as HTMLElement & { __e2eDndOwner?: string }).__e2eDndOwner = "stable"
    }, { scrollId: tid.channelSidebarScroll, rowId: tid.channelRow(fastChannel) })
    await runRenderedNavigation(page, testInfo, "fast-detail", `[data-testid="${tid.channelRow(fastChannel)}"]`, detailContract(root, fastChannel, fastName), async () => { await fastRow.click(); await ready(fastChannel); await identity() })
    await runRenderedNavigation(page, testInfo, "semantic-Back", 'button[aria-label="Back"]', listContract(fastPath, fastChannel, fastName), async () => { await page.getByRole("banner").getByRole("button", { name: "Back" }).click(); await list() })
    const gate = await holdRoute(page, pendingPath); gates.push(gate)
    await runRenderedNavigation(page, testInfo, "pending-or-immediate-detail", `[data-testid="${tid.channelRow(pendingChannel)}"]`, detailContract(root, pendingChannel, pendingName), async () => {
      try { await page.getByTestId(tid.channelRow(pendingChannel)).click({ noWaitAfter: true }); await expect.poll(gate.held).toBeGreaterThan(0) } finally { await gate.release() }
      await ready(pendingChannel); await identity()
      await captureReadyConversation(page, { pathname: pendingPath, serverId, channelId: pendingChannel, kind: "text", empty: true, layout: "mobile-detail" }, testInfo, "qualified-mobile-detail")
    })
    await runRenderedNavigation(page, testInfo, "history-back", null, { ...listContract(pendingPath, pendingChannel, pendingName), actionKind: "programmatic" }, async () => { await page.goBack(); await list() })
    await runRenderedNavigation(page, testInfo, "history-forward", null, { ...detailContract(root, pendingChannel, pendingName), actionKind: "programmatic" }, async () => { await page.goForward(); await ready(pendingChannel); await identity() })
    await runRenderedNavigation(page, testInfo, "history-back-before-Home", null, { ...listContract(pendingPath, pendingChannel, pendingName), actionKind: "programmatic" }, async () => { await page.goBack(); await list() })
    await runRenderedNavigation(page, testInfo, "Home-list", `[data-testid="${tid.homeButton}"]`, { paths: [root, "/c/me"], finalPath: "/c/me", scopes: [scope], listStates: ["server", "friends", "friends-pending", "me-pending"], allowMeRootPending: true, pendingKind: "me", finalListState: "friends", stationary: true }, async () => { await page.getByTestId(tid.homeButton).click(); await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me"); await expect(page.getByPlaceholder("Search friends")).toBeVisible() })
    await runRenderedNavigation(page, testInfo, "Home-server-restore", `[data-testid="${tid.serverIcon(serverId)}"]`, { paths: ["/c/me", root], finalPath: root, scopes: [scope], finalScope: scope, allowedRows: [fastChannel], listStates: ["friends", "friends-pending", "server"], pendingKind: "server-landing", finalListState: "server", stationary: true }, async () => { await page.getByTestId(tid.serverIcon(serverId)).click(); await list(false) })
    transport.assertHealthy()
  } finally {
    for (const gate of gates) await gate.release()
    await page.evaluate(() => { delete (window as typeof window & { __retainedSidebar?: unknown }).__retainedSidebar })
    await testInfo.attach("held-routes", { body: JSON.stringify(gates.map((gate) => gate.snapshot())), contentType: "application/json" })
    await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" }); transport.stop()
  }
})
