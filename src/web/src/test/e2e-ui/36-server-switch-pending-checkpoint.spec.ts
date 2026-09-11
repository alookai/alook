import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

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

async function installSidebarFrameProbe(page: Page) {
  const channelRowPrefix = tid.channelRow("")
  await page.addInitScript(({ channelRowPrefix }) => {
    const state = window as typeof window & { __communitySidebarFrames?: SidebarFrame[] }
    state.__communitySidebarFrames = []
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
    ;(window as typeof window & { __communitySidebarFrames?: SidebarFrame[] })
      .__communitySidebarFrames = []
  })
}

async function sidebarFrames(page: Page): Promise<SidebarFrame[]> {
  return page.evaluate(() => (
    window as typeof window & { __communitySidebarFrames?: SidebarFrame[] }
  ).__communitySidebarFrames ?? [])
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
  // Focus activates the accessible menu path and starts Server-root prefetch.
  // The trigger and button are already stable, so the same node receives the
  // following physical click, including during an immediate A→B supersession.
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

test("server switching exposes one target-scoped cold checkpoint and skips it when warm", async ({ asUser }) => {
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
  await page.setViewportSize({ width: 1280, height: 900 })
  await installSidebarFrameProbe(page)
  await page.goto(`/c/channels/${serverA}/${channelA}`)
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })

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

  // Install every cold gate before the first physical rail movement. Moving
  // the pointer between vertically stacked icons can cross another icon and
  // legitimately trigger its hover prefetch; those targets must stay cold
  // until their explicit phase below.
  const coldC = await holdServerTransition(page, serverC)
  const coldD = await holdServerTransition(page, serverD)
  const coldE = await holdServerTransition(page, serverE)
  const coldF = await holdServerTransition(page, serverF)

  // Visit B once so both its route and live detail query are deterministically
  // memory-warm, then return to A before sampling the warm switch.
  await clickServer(page, serverB)
  await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })
  await clickServer(page, serverA)
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })

  await clearSidebarFrames(page)
  await clickServer(page, serverB)
  await expect(page.getByTestId(tid.channelSidebarPending(serverB))).toHaveCount(0)
  await expect(page.getByTestId(tid.pendingMain("server-landing"))).toHaveCount(0)
  await expectDesktopServerDetail(page, serverB)
  await expect(page.locator("#sidebar").getByRole("button", { name: serverBName, exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })
  expectAtomicTargetFrames(
    await sidebarFrames(page),
    `server:${serverB}`,
    channelB,
    [channelA],
  )

  await clickServer(page, serverA)
  await expectDesktopServerDetail(page, serverA)
  await expect(page.locator("#sidebar").getByRole("button", { name: serverAName, exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
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
  const coldFrames = await sidebarFrames(page)
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
  await expectActiveServer(page, serverA, serverC)

  // A reload restores the persisted structural snapshot but not the live
  // server-detail query. Hold C's fresh reads so its first non-skeleton frame
  // must come from the structural target tree, then reconcile in the same owner.
  await page.waitForTimeout(1_000)
  await page.reload()
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
  const structuralC = await holdServerTransition(page, serverC)
  await clearSidebarFrames(page)
  await clickServer(page, serverC)
  await expect.poll(structuralC.heldNavigation).toBeGreaterThan(0)
  await structuralC.release()
  await expectDesktopServerDetail(page, serverC)
  await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible({ timeout: 30_000 })
  expectAtomicTargetFrames(
    await sidebarFrames(page),
    `server:${serverC}`,
    channelC,
    [channelA, channelB],
  )

  await clickServer(page, serverA)
  await expectDesktopServerDetail(page, serverA)
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })

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
  const mobileColdFrames = await sidebarFrames(page)
  expectAtomicTargetFrames(
    mobileColdFrames,
    `server:${serverD}`,
    channelD,
    [channelA, channelB, channelC],
  )

  await page.setViewportSize({ width: 1280, height: 900 })
  await expectDesktopServerDetail(page, serverD)
  await expect(page.getByTestId(tid.serverIcon(serverE))).toBeVisible()
  await clearSidebarFrames(page)
  await clickServer(page, serverE)
  // Dispatch the superseding click directly against the current stable
  // button so this remains one immediate E→F intent window; awaiting F's
  // focus-driven prefetch would serialize the two intents.
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
  const supersededFrames = await sidebarFrames(page)
  expect(supersededFrames.some((frame) => frame.scope === `server:${serverE}`)).toBe(false)
  expectAtomicTargetFrames(
    supersededFrames,
    `server:${serverF}`,
    channelF,
    [channelA, channelB, channelC, channelD, channelE],
  )
})
