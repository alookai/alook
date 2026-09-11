import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

async function holdRoute(page: Page, pathname: string) {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let held = 0
  const pattern = `**${pathname}**`
  const handler = async (route: Route) => {
    held += 1
    await gate
    await route.continue()
  }
  await page.route(pattern, handler)
  return {
    held: () => held,
    release: async () => {
      releaseGate()
      await page.waitForTimeout(100)
      await page.unroute(pattern, handler)
    },
  }
}

function channelHeader(page: Page, name: string) {
  return page.getByRole("banner").getByText(name, { exact: true })
}

type SurfaceAnimationRecord = {
  surface: string | null
}

type SurfaceFrameRecord = {
  pathname: string
  surface: string | null
  transform: string
  opacity: string
  rows: string[]
  pendingMain: string | null
  treeScope: string | null
}

async function installSurfaceAnimationProbe(page: Page) {
  const channelRowPrefix = tid.channelRow("")
  await page.addInitScript(({ channelRowPrefix }) => {
    const state = window as typeof window & {
      __communitySurfaceAnimations?: Array<{
        surface: string | null
      }>
      __communitySurfaceFrames?: SurfaceFrameRecord[]
      __communitySurfaceFrameStop?: () => void
    }
    state.__communitySurfaceAnimations = []
    state.__communitySurfaceFrames = []
    const nativeAnimate = Element.prototype.animate
    Element.prototype.animate = function (keyframes, options) {
      if (this.hasAttribute("data-community-mobile-surface")) {
        state.__communitySurfaceAnimations!.push({
          surface: this.getAttribute("data-community-mobile-surface"),
        })
      }
      return nativeAnimate.call(this, keyframes, options)
    }

    let raf = 0
    const sample = () => {
      for (const surface of document.querySelectorAll<HTMLElement>("[data-community-mobile-surface]")) {
        const style = getComputedStyle(surface)
        if (style.display === "none" || surface.getClientRects().length === 0) continue
        const rows = Array.from(surface.querySelectorAll<HTMLElement>(
          `[data-testid^="${channelRowPrefix}"]`,
        )).filter((row) => {
          const rowStyle = getComputedStyle(row)
          return rowStyle.display !== "none" && row.getClientRects().length > 0
        }).map((row) => row.dataset.testid!.replace(channelRowPrefix, ""))
        state.__communitySurfaceFrames!.push({
          pathname: location.pathname,
          surface: surface.getAttribute("data-community-mobile-surface"),
          transform: style.transform,
          opacity: style.opacity,
          rows,
          pendingMain: surface.querySelector<HTMLElement>("[data-community-main-kind]")
            ?.dataset.communityMainKind ?? null,
          treeScope: surface.querySelector<HTMLElement>("[data-community-channel-tree-scope]")
            ?.dataset.communityChannelTreeScope ?? null,
        })
      }
      raf = requestAnimationFrame(sample)
    }
    raf = requestAnimationFrame(sample)
    state.__communitySurfaceFrameStop = () => cancelAnimationFrame(raf)
  }, { channelRowPrefix })
}

async function surfaceAnimations(page: Page): Promise<SurfaceAnimationRecord[]> {
  return page.evaluate(() => (
    window as typeof window & { __communitySurfaceAnimations?: SurfaceAnimationRecord[] }
  ).__communitySurfaceAnimations ?? [])
}

async function clearSurfaceAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __communitySurfaceAnimations?: SurfaceAnimationRecord[]
      __communitySurfaceFrames?: SurfaceFrameRecord[]
    }
    state.__communitySurfaceAnimations = []
    state.__communitySurfaceFrames = []
  })
}

async function surfaceFrames(page: Page): Promise<SurfaceFrameRecord[]> {
  return page.evaluate(() => (
    window as typeof window & { __communitySurfaceFrames?: SurfaceFrameRecord[] }
  ).__communitySurfaceFrames ?? [])
}

function expectStationaryFrames(frames: SurfaceFrameRecord[]) {
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(frame.transform)
    expect(frame.opacity).toBe("1")
  }
}

test("community checkpoint shows target pending for detail and keeps list surfaces stable", async ({ asUser }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Frame Gate ${stamp}`)
  const channelAName = `frame-a-${stamp}`
  const channelBName = `frame-b-${stamp}`
  const channelA = await seedChannel("alice", serverId, channelAName)
  const channelB = await seedChannel("alice", serverId, channelBName)
  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${serverId}/${channelA}`)
  await expect(channelHeader(page, channelAName)).toBeVisible({ timeout: 30_000 })

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
    ) mutations.push(`${method} ${pathname}`)
  })

  const leafGate = await holdRoute(page, `/c/channels/${serverId}/${channelB}`)
  await page.getByTestId(tid.channelRow(channelB)).click({ noWaitAfter: true })
  await expect.poll(leafGate.held).toBeGreaterThan(0)
  await expect(page.getByLabel("Resolving conversation")).toBeVisible()
  await expect(channelHeader(page, channelAName)).toHaveCount(0)
  await page.waitForTimeout(150)
  await expect(page.getByLabel("Resolving conversation")).toBeVisible()
  await expect(channelHeader(page, channelAName)).toHaveCount(0)
  await leafGate.release()
  await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })

  await page.setViewportSize({ width: 390, height: 844 })
  const rootGate = await holdRoute(page, `/c/channels/${serverId}`)
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click({ noWaitAfter: true })
  await expect.poll(rootGate.held).toBeGreaterThan(0)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(channelHeader(page, channelBName)).toBeVisible()
  await page.waitForTimeout(150)
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(channelHeader(page, channelBName)).toBeVisible()
  await rootGate.release()
  await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })

  await page.goto("/c/me/friends")
  await expect(page.getByPlaceholder("Search friends")).toBeVisible({ timeout: 30_000 })
  const machinesGate = await holdRoute(page, "/c/me/machines")
  await page.getByRole("button", { name: "Machines", exact: true }).click({ noWaitAfter: true })
  await expect.poll(machinesGate.held).toBeGreaterThan(0)
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(page.getByPlaceholder("Search friends")).toBeVisible()
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder("Search friends")).toBeVisible()
  await machinesGate.release()
  await expect(page.getByTestId(tid.machinePairOpen))
    .toBeVisible({ timeout: 30_000 })

  expect(mutations).toEqual([])
})

test("mobile route commits stay stationary while sidebar identity survives same-server history", async ({ asUser }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `Mobile frame ${stamp}`)
  const fastName = `fast-${stamp}`
  const pendingName = `pending-${stamp}`
  const fastChannel = await seedChannel("alice", serverId, fastName)
  const pendingChannel = await seedChannel("alice", serverId, pendingName)
  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 390, height: 844 })
  await installSurfaceAnimationProbe(page)
  await page.goto(`/c/channels/${serverId}`)

  const fastRow = page.getByTestId(tid.channelRow(fastChannel))
  const sidebarScroll = page.getByTestId(tid.channelSidebarScroll)
  await expect(fastRow).toBeVisible({ timeout: 30_000 })
  await sidebarScroll.evaluate((element) => {
    ;(element as typeof element & { __e2eIdentity?: string }).__e2eIdentity = "stable"
  })
  await fastRow.evaluate((element) => {
    ;(element as typeof element & { __e2eDndOwner?: string }).__e2eDndOwner = "stable"
  })
  await clearSurfaceAnimations(page)

  await fastRow.click()
  await expect.poll(() => new URL(page.url()).pathname)
    .toBe(`/c/channels/${serverId}/${fastChannel}`)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await clearSurfaceAnimations(page)
  await page.getByTestId(tid.channelRow(pendingChannel)).click({ noWaitAfter: true })
  await expect(page.getByTestId(tid.pendingMain("server-conversation"))).toBeVisible()

  const pendingPath = `/c/channels/${serverId}/${pendingChannel}`
  await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 30_000 })
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await page.goBack()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  await page.goForward()
  await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))

  await page.goBack()
  await expect(fastRow).toBeVisible()
  await page.getByTestId(tid.homeButton).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
  await page.getByTestId(tid.serverIcon(serverId)).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  const finalFrames = await surfaceFrames(page)
  expectStationaryFrames(finalFrames)
  const targetFrames = finalFrames.filter((frame) => frame.rows.includes(fastChannel))
  expect(targetFrames.length).toBeGreaterThan(0)
  expect(targetFrames.every((frame) => frame.treeScope === `server:${serverId}`)).toBe(true)
})
