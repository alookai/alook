import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type HeldServer = {
  heldNavigation: () => number
  release: () => Promise<void>
}

async function holdServerTransition(
  page: Page,
  serverId: string,
  { detail = true }: { detail?: boolean } = {},
): Promise<HeldServer> {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let heldNavigation = 0
  const patterns: Array<{ pattern: string; navigation: boolean }> = [
    { pattern: `**/c/channels/${serverId}**`, navigation: true },
    ...(detail ? [
      { pattern: `**/api/community/servers/${serverId}/categories**`, navigation: false },
      { pattern: `**/api/community/servers/${serverId}/channels**`, navigation: false },
      { pattern: `**/api/community/servers/${serverId}/unreads**`, navigation: false },
    ] : []),
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
  // The first focus lazily mounts the icon's context-menu wrapper and replaces
  // the trigger node. Let that a11y activation path settle so the following
  // physical click targets the stable button rather than the pre-activation
  // node, including during an immediate A→B supersession.
  await icon.focus()
  await expect(icon.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]"))
    .toBeVisible()
  return icon
}

async function clickServer(page: Page, serverId: string): Promise<void> {
  const icon = await activateServerIcon(page, serverId)
  await icon.click({ noWaitAfter: true })
}

async function expectActiveServer(page: Page, activeId: string, inactiveId: string): Promise<void> {
  await expect(page.getByTestId(tid.serverIcon(activeId))).toHaveClass(/cursor-default/)
  await expect(page.getByTestId(tid.serverIcon(inactiveId))).toHaveClass(/cursor-pointer/)
}

test("server switching exposes one target-scoped cold checkpoint and skips it when warm", async ({ asUser }) => {
  test.setTimeout(120_000)
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
  await seedChannel("alice", serverE, `checkpoint-e-${stamp}`)
  await seedChannel("alice", serverF, `checkpoint-f-${stamp}`)

  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 900 })
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

  // A warm destination means the exact server detail has already settled in
  // this page's QueryClient. Let B's focus prefetch fill that cache while only
  // its RSC request is held, and wait for every constituent detail response
  // to finish before the actual navigation intent begins.
  const warmB = await holdServerTransition(page, serverB, { detail: false })
  const detailResponses = Promise.all([
    "categories", "channels", "unreads",
  ].map((resource) => page.waitForResponse((response) =>
    response.url().includes(`/api/community/servers/${serverB}/${resource}`)
      && response.status() === 200
  )))
  const serverBIcon = await activateServerIcon(page, serverB)
  const responses = await detailResponses
  await Promise.all(responses.map((response) => response.finished()))
  await page.waitForTimeout(100)
  await serverBIcon.click({ noWaitAfter: true })
  await expect.poll(warmB.heldNavigation).toBeGreaterThan(0)
  await expect(page.getByTestId(tid.channelSidebarPending(serverB))).toHaveCount(0)
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible()
  await expectActiveServer(page, serverA, serverB)
  await warmB.release()
  await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverB}`))
    .toBe(true)
  await expect(page.getByRole("button", { name: serverBName, exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(tid.channelRow(channelB))).toBeVisible({ timeout: 30_000 })

  await clickServer(page, serverA)
  await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverA}`))
    .toBe(true)
  await expect(page.getByRole("button", { name: serverAName, exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
  await expectActiveServer(page, serverA, serverB)

  await clickServer(page, serverC)
  await expect.poll(coldC.heldNavigation).toBeGreaterThan(0)
  await expect(page.getByTestId(tid.channelSidebarPending(serverC))).toBeVisible()
  await expect(page.getByLabel("Loading conversation")).toBeVisible()
  await expect(page.getByRole("button", { name: channelAName })).toHaveCount(0)
  await expectActiveServer(page, serverC, serverA)
  expect(mutations).toEqual([])
  await coldC.release()
  await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverC}`))
    .toBe(true)
  await expect(page.getByTestId(tid.channelSidebarPending(serverC))).toHaveCount(0)
  await expect(page.getByTestId(tid.channelRow(channelC))).toBeVisible({ timeout: 30_000 })

  await clickServer(page, serverA)
  await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverA}`))
    .toBe(true)
  await expect(page.getByRole("button", { name: serverAName, exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("heading", { name: channelAName })).toBeVisible({ timeout: 30_000 })
  await expectActiveServer(page, serverA, serverC)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname === `/c/channels/${serverA}`)
    .toBe(true)
  await expect(page.getByTestId(tid.serverIcon(serverD))).toBeVisible()

  await clickServer(page, serverD)
  await expect.poll(coldD.heldNavigation).toBeGreaterThan(0)
  const mobileCheckpoint = page.getByTestId(tid.channelSidebarPending(serverD))
  await expect(mobileCheckpoint).toBeVisible()
  await expect(page.getByRole("button", { name: channelAName })).toHaveCount(0)
  const mobileBox = await mobileCheckpoint.boundingBox()
  expect(mobileBox).not.toBeNull()
  expect(mobileBox!.width).toBeGreaterThan(300)
  expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390)
  await expectActiveServer(page, serverD, serverA)
  await coldD.release()
  await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverD}`))
    .toBe(true)
  await expect(page.getByTestId(tid.channelRow(channelD))).toBeVisible({ timeout: 30_000 })

  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByTestId(tid.serverIcon(serverE))).toBeVisible()
  await clickServer(page, serverE)
  // Dispatch the superseding click directly against the current stable
  // button so this remains one immediate E→F intent window; waiting for F's
  // unrelated lazy context-menu wrapper would serialize the two intents.
  await page.getByTestId(tid.serverIcon(serverF)).dispatchEvent("click")
  await expect.poll(coldF.heldNavigation).toBeGreaterThan(0)
  await expect(page.getByTestId(tid.channelSidebarPending(serverE))).toHaveCount(0)
  await expect(page.getByTestId(tid.channelSidebarPending(serverF))).toBeVisible()
  await expectActiveServer(page, serverF, serverD)
  await coldE.release()
  await expect(page.getByTestId(tid.channelSidebarPending(serverF))).toBeVisible()
  await expectActiveServer(page, serverF, serverD)
  await coldF.release()
  await expect.poll(() => new URL(page.url()).pathname.startsWith(`/c/channels/${serverF}`))
    .toBe(true)
})
