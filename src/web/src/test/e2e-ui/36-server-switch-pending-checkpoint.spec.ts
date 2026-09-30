import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { expectConversationReady, observeConversationTransport } from "./_fixtures/conversation-readiness"
import { WEB_URL } from "./_setup/paths"

test.beforeEach(async ({ baseURL }) => {
  expect(baseURL, "seed helper origin must match the browser before any mutation").toBeTruthy()
  expect(new URL(WEB_URL).origin).toBe(new URL(baseURL!).origin)
})

type HeldServer = {
  heldNavigation: () => number
  release: () => Promise<void>
}

type SidebarFrame = {
  pathname: string
  ownerId: number | null
  scope: string | null
  pendingServer: string | null
  skeleton: boolean
  rows: string[]
  transform: string | null
  opacity: string | null
}

type HistoryEvent = {
  kind: "pushState" | "replaceState" | "popstate"
  pathname: string
}

async function installSidebarFrameProbe(page: Page) {
  const channelRowPrefix = tid.channelRow("")
  await page.addInitScript(({ channelRowPrefix }) => {
    const state = window as typeof window & {
      __communityHistoryEvents?: HistoryEvent[]
      __communitySidebarFrames?: SidebarFrame[]
    }
    state.__communitySidebarFrames = []
    state.__communityHistoryEvents = []
    const recordHistory = (
      kind: HistoryEvent["kind"],
      href: string | URL | null | undefined,
    ) => {
      const url = href == null ? new URL(location.href) : new URL(String(href), location.href)
      state.__communityHistoryEvents!.push({ kind, pathname: url.pathname })
    }
    const pushState = history.pushState.bind(history)
    history.pushState = (...args) => {
      recordHistory("pushState", args[2])
      return pushState(...args)
    }
    const replaceState = history.replaceState.bind(history)
    history.replaceState = (...args) => {
      recordHistory("replaceState", args[2])
      return replaceState(...args)
    }
    addEventListener("popstate", () => recordHistory("popstate", location.href))
    const ownerIds = new WeakMap<Element, number>()
    let nextOwnerId = 0
    const sample = () => {
      const surface = document.querySelector<HTMLElement>('[data-community-mobile-surface="list"]')
      const sidebar = surface ?? document.querySelector<HTMLElement>("#sidebar")
      const owner = sidebar?.querySelector<HTMLElement>("[data-community-channel-tree-scope]") ?? null
      let ownerId: number | null = null
      if (owner) {
        ownerId = ownerIds.get(owner) ?? ++nextOwnerId
        ownerIds.set(owner, ownerId)
      }
      const rows = Array.from(sidebar?.querySelectorAll<HTMLElement>(
        `[data-testid^="${channelRowPrefix}"]`,
      ) ?? []).filter((row) => {
        const style = getComputedStyle(row)
        return style.display !== "none" && row.getClientRects().length > 0
      }).map((row) => row.dataset.testid!.replace(channelRowPrefix, ""))
      const surfaceStyle = surface ? getComputedStyle(surface) : null
      state.__communitySidebarFrames!.push({
        pathname: location.pathname,
        ownerId,
        scope: owner?.dataset.communityChannelTreeScope ?? null,
        pendingServer: sidebar?.querySelector<HTMLElement>("[data-pending-server-id]")
          ?.dataset.pendingServerId ?? null,
        skeleton: sidebar?.querySelector('[data-slot="skeleton"]') !== null,
        rows,
        transform: surfaceStyle?.transform ?? null,
        opacity: surfaceStyle?.opacity ?? null,
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, { channelRowPrefix })
}

async function clearSidebarFrames(page: Page) {
  await page.evaluate(() => {
    ; (window as typeof window & { __communitySidebarFrames?: SidebarFrame[] })
      .__communitySidebarFrames = []
  })
}

async function clearHistoryEvents(page: Page) {
  await page.evaluate(() => {
    ; (window as typeof window & { __communityHistoryEvents?: HistoryEvent[] })
      .__communityHistoryEvents = []
  })
}

async function historyEvents(page: Page): Promise<HistoryEvent[]> {
  return page.evaluate(() => (
    window as typeof window & { __communityHistoryEvents?: HistoryEvent[] }
  ).__communityHistoryEvents ?? [])
}

async function sidebarFrames(page: Page): Promise<SidebarFrame[]> {
  return page.evaluate(() => (
    window as typeof window & { __communitySidebarFrames?: SidebarFrame[] }
  ).__communitySidebarFrames ?? [])
}

async function paintedSidebarFrames(page: Page, scope: string, targetRow: string) {
  await page.waitForFunction(({ scope, targetRow }) => (
    window as typeof window & { __communitySidebarFrames?: SidebarFrame[] }
  ).__communitySidebarFrames?.some((frame) => (
    frame.scope === scope && !frame.skeleton && frame.rows.includes(targetRow)
  )), { scope, targetRow }, { polling: "raf", timeout: 30_000 })
  return sidebarFrames(page)
}

function expectAtomicTargetFrames(
  frames: SidebarFrame[],
  scope: string,
  targetRow: string,
  forbiddenRows: string[],
) {
  const target = frames.filter((frame) => frame.scope === scope)
  expect(target.length).toBeGreaterThan(0)
  expect(new Set(target.map((frame) => frame.ownerId)).size).toBe(1)
  const committed = target.filter((frame) => !frame.skeleton)
  expect(committed.length).toBeGreaterThan(0)
  expect(committed[0].rows).toContain(targetRow)
  for (const frame of committed) {
    expect(frame.rows).toContain(targetRow)
    expect(frame.rows.some((row) => forbiddenRows.includes(row))).toBe(false)
    if (frame.transform !== null) {
      expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(frame.transform)
      expect(frame.opacity).toBe("1")
    }
  }
}

async function holdServerTransition(
  page: Page,
  serverId: string,
): Promise<HeldServer> {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let heldNavigation = 0
  const patterns: Array<{ pattern: string; navigation: boolean }> = [
    { pattern: `**/c/channels/${serverId}**`, navigation: true },
    { pattern: `**/api/community/servers/${serverId}/categories**`, navigation: false },
    { pattern: `**/api/community/servers/${serverId}/channels**`, navigation: false },
    { pattern: `**/api/community/servers/${serverId}/unreads**`, navigation: false },
  ]
  const handlers = new Map<string, (route: Route) => Promise<void>>()
  for (const { pattern, navigation } of patterns) {
    const handler = async (route: Route) => {
      if (navigation) heldNavigation += 1
      await gate
      await route.continue()
    }
    handlers.set(pattern, handler)
    await page.route(pattern, handler)
  }
  return {
    heldNavigation: () => heldNavigation,
    release: async () => {
      releaseGate()
      await page.waitForTimeout(100)
      await Promise.all([...handlers].map(([pattern, handler]) => page.unroute(pattern, handler)))
    },
  }
}

async function activateServerIcon(page: Page, serverId: string) {
  const icon = page.getByTestId(tid.serverIcon(serverId))
  await icon.focus()
  await expect(icon.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]"))
    .toBeVisible()
  return icon
}

async function clickServer(page: Page, serverId: string): Promise<void> {
  const icon = await activateServerIcon(page, serverId)
  await icon.click({ noWaitAfter: true })
}

async function expectDesktopServerDetail(page: Page, serverId: string): Promise<void> {
  const prefix = `/c/channels/${serverId}/`
  await expect.poll(() => new URL(page.url()).pathname.startsWith(prefix)).toBe(true)
}

async function expectActiveServer(page: Page, activeId: string, inactiveId: string): Promise<void> {
  await expect(page.getByTestId(tid.serverIcon(activeId))).toHaveClass(/cursor-default/)
  await expect(page.getByTestId(tid.serverIcon(inactiveId))).toHaveClass(/cursor-pointer/)
}

test("server switching exposes one target-scoped cold checkpoint and skips it when warm", async ({ asUser }, testInfo) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const serverA = await seedServer("alice", `Checkpoint A ${stamp}`)
  const serverB = await seedServer("alice", `Checkpoint B ${stamp}`)
  const serverC = await seedServer("alice", `Checkpoint C ${stamp}`)
  const serverD = await seedServer("alice", `Checkpoint D ${stamp}`)
  const serverE = await seedServer("alice", `Checkpoint E ${stamp}`)
  const serverF = await seedServer("alice", `Checkpoint F ${stamp}`)
  const serverAName = `Checkpoint-A-${stamp}`
  const serverBName = `Checkpoint-B-${stamp}`
  const channelAName = `checkpoint-a-${stamp}`
  const channelBName = `checkpoint-b-${stamp}`
  const channelCName = `checkpoint-c-${stamp}`
  const channelDName = `checkpoint-d-${stamp}`
  const channelA = await seedChannel("alice", serverA, channelAName)
  const channelB = await seedChannel("alice", serverB, channelBName)
  const channelC = await seedChannel("alice", serverC, channelCName)
  const channelD = await seedChannel("alice", serverD, channelDName)
  const channelE = await seedChannel("alice", serverE, `checkpoint-e-${stamp}`)
  const channelF = await seedChannel("alice", serverF, `checkpoint-f-${stamp}`)

  const { page } = await asUser("alice")
  const transport = observeConversationTransport(page)
  const ready = async (serverId: string, pathname = new URL(page.url()).pathname) => {
    expect(pathname).toMatch(new RegExp(`^/c/channels/${serverId}/[^/]+$`))
    await expectConversationReady(page, { pathname, serverId, channelId: pathname.split("/").at(-1)!, kind: "text", empty: true }, testInfo)
    transport.assertHealthy()
  }
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installSidebarFrameProbe(page)
    await page.goto(`/c/channels/${serverA}/${channelA}`)
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await ready(serverA, `/c/channels/${serverA}/${channelA}`)

    const readOnlyPostPaths = new Set([
      "/api/community/messages/batch",
      "/api/community/messages/tags/batch",
      "/api/community/channels/participants/batch",
    ])
    const mutations: string[] = []
    page.on("request", (request) => {
      const method = request.method()
      const pathname = new URL(request.url()).pathname
      if (
        !["GET", "HEAD", "OPTIONS"].includes(method)
        && !(method === "POST" && readOnlyPostPaths.has(pathname))
      ) {
        mutations.push(`${method} ${pathname}`)
      }
    })

    const coldC = await holdServerTransition(page, serverC)
    const coldD = await holdServerTransition(page, serverD)
    const coldE = await holdServerTransition(page, serverE)
    const coldF = await holdServerTransition(page, serverF)

    // Visit B once so both its route and live detail query are deterministically
    // memory-warm, then return to A before sampling the warm switch.
    await clickServer(page, serverB)
    await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })
    await expectDesktopServerDetail(page, serverB)
    await ready(serverB)
    const rememberedBPath = new URL(page.url()).pathname
    await clickServer(page, serverA)
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await ready(serverA, `/c/channels/${serverA}/${channelA}`)

    await clearSidebarFrames(page)
    await clickServer(page, serverB)
    await expect(page.getByTestId(tid.channelSidebarPending(serverB))).toHaveCount(0)
    await expect(page.getByTestId(tid.pendingMain("server-landing"))).toHaveCount(0)
    await expectDesktopServerDetail(page, serverB)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverBName, exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })
    await expectDesktopServerDetail(page, serverB)
    await ready(serverB, rememberedBPath)
    expectAtomicTargetFrames(
      await paintedSidebarFrames(page, `server:${serverB}`, channelB),
      `server:${serverB}`,
      channelB,
      [channelA],
    )

    await clickServer(page, serverA)
    await expectDesktopServerDetail(page, serverA)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverAName, exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await ready(serverA, `/c/channels/${serverA}/${channelA}`)
    await expectActiveServer(page, serverA, serverB)

    await clearSidebarFrames(page)
    await clickServer(page, serverC)
    await expect.poll(coldC.heldNavigation).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.channelSidebarPending(serverC))).toBeVisible()
    await expect(page.getByTestId(tid.pendingMain("server-landing"))).toBeVisible()
    await expect(page.getByRole("button", { name: channelAName, exact: true })).toHaveCount(0)
    await expectActiveServer(page, serverC, serverA)
    expect(mutations).toEqual([])
    await coldC.release()
    await expectDesktopServerDetail(page, serverC)
    await expect(page.getByTestId(tid.channelSidebarPending(serverC))).toHaveCount(0)
    await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible({ timeout: 30_000 })
    const rememberedCPath = new URL(page.url()).pathname
    await ready(serverC, rememberedCPath)
    const coldFrames = await paintedSidebarFrames(page, `server:${serverC}`, channelC)
    const coldPendingFrames = coldFrames.filter((frame) => frame.pendingServer === serverC)
    expect(coldPendingFrames.length).toBeGreaterThan(0)
    expect(coldPendingFrames.every((frame) => frame.ownerId === null && frame.rows.length === 0))
      .toBe(true)
    expectAtomicTargetFrames(coldFrames, `server:${serverC}`, channelC, [channelA])

    await clickServer(page, serverA)
    await expectDesktopServerDetail(page, serverA)
    await expect(page.locator("#sidebar").getByRole("button", { name: serverAName, exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await ready(serverA, `/c/channels/${serverA}/${channelA}`)
    await expectActiveServer(page, serverA, serverC)

    // A reload restores the persisted structural snapshot but not the live
    // server-detail query. Hold C's fresh reads so its first non-skeleton frame
    // must come from the structural target tree, then reconcile in the same owner.
    await page.waitForTimeout(1_000)
    await page.reload()
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await ready(serverA, `/c/channels/${serverA}/${channelA}`)
    const structuralC = await holdServerTransition(page, serverC)
    const targetRscStart = Date.now()
    await clearSidebarFrames(page)
    await clearHistoryEvents(page)
    try {
      await clickServer(page, serverC)
      await expect.poll(structuralC.heldNavigation).toBeGreaterThan(0)
      await structuralC.release()
      await ready(serverC, rememberedCPath)
      const targetRequests = transport.targetRsc(serverC, targetRscStart)
      expect(targetRequests).toHaveLength(1)
      expect(targetRequests[0]).toMatchObject({ pathname: rememberedCPath, prefetch: false, status: 200 })
      await expectDesktopServerDetail(page, serverC)
      await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible({ timeout: 30_000 })
      expectAtomicTargetFrames(
        await paintedSidebarFrames(page, `server:${serverC}`, channelC),
        `server:${serverC}`,
        channelC,
        [channelA, channelB],
      )
      const navigationEvents = await historyEvents(page)
      expect(navigationEvents).toEqual([{
        kind: "pushState",
        pathname: rememberedCPath,
      }])
    } finally {
      await testInfo.attach("remembered-C-transport", { body: JSON.stringify(transport.targetRsc(serverC, targetRscStart)), contentType: "application/json" })
    }

    await clickServer(page, serverA)
    await expectDesktopServerDetail(page, serverA)
    await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
    await ready(serverA, `/c/channels/${serverA}/${channelA}`)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname === `/c/channels/${serverA}`)
      .toBe(true)
    await expect(page.getByTestId(tid.serverIcon(serverD))).toBeVisible()

    await clearSidebarFrames(page)
    await clickServer(page, serverD)
    await expect.poll(coldD.heldNavigation).toBeGreaterThan(0)
    const mobileCheckpoint = page.getByTestId(tid.channelSidebarPending(serverD))
    await expect(mobileCheckpoint).toBeVisible()
    await expect(page.getByRole("button", { name: channelAName, exact: true })).toHaveCount(0)
    const mobileBox = await mobileCheckpoint.boundingBox()
    expect(mobileBox).not.toBeNull()
    expect(mobileBox!.width).toBeGreaterThan(300)
    expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390)
    await expectActiveServer(page, serverD, serverA)
    await coldD.release()
    await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverD}`))
      .toBe(true)
    await expect(page.getByTestId(tid.channelRow(channelD))).toBeVisible({ timeout: 30_000 })
    const mobileColdFrames = await paintedSidebarFrames(page, `server:${serverD}`, channelD)
    expectAtomicTargetFrames(
      mobileColdFrames,
      `server:${serverD}`,
      channelD,
      [channelA, channelB, channelC],
    )

    await page.setViewportSize({ width: 1280, height: 900 })
    await expectDesktopServerDetail(page, serverD)
    await ready(serverD)
    await expect(page.getByTestId(tid.serverIcon(serverE))).toBeVisible()
    await clearSidebarFrames(page)
    await clickServer(page, serverE)
    // Dispatch the superseding click directly against the current stable
    // button so this remains one immediate E→F intent window; awaiting F's
    // menu focus would serialize the two intents.
    await page.getByTestId(tid.serverIcon(serverF)).dispatchEvent("click")
    await expect.poll(coldF.heldNavigation).toBeGreaterThan(0)
    await expect(page.getByTestId(tid.channelSidebarPending(serverE))).toHaveCount(0)
    await expect(page.getByTestId(tid.channelSidebarPending(serverF))).toBeVisible()
    await expectActiveServer(page, serverF, serverD)
    await coldE.release()
    await expect(page.getByTestId(tid.channelSidebarPending(serverF))).toBeVisible()
    await expectActiveServer(page, serverF, serverD)
    await coldF.release()
    await expectDesktopServerDetail(page, serverF)
    await expect(page.getByTestId(tid.channelRow(channelF))).toBeVisible({ timeout: 30_000 })
    await ready(serverF)
    const supersededFrames = await paintedSidebarFrames(page, `server:${serverF}`, channelF)
    expect(supersededFrames.some((frame) => frame.scope === `server:${serverE}`)).toBe(false)
    expectAtomicTargetFrames(
      supersededFrames,
      `server:${serverF}`,
      channelF,
      [channelA, channelB, channelC, channelD, channelE],
    )
    expect(mutations).toEqual([])
    transport.assertHealthy()
  } finally {
    await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" })
    await testInfo.attach("navigation-state", { body: await page.screenshot(), contentType: "image/png" })
    transport.stop()
  }
})
