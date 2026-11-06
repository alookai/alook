import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"

import { tid } from "./_fixtures/testids"
import { holdRoute } from "./_fixtures/held-route"

function channelHeader(page: Page, name: string) {
  return page.getByRole("banner").getByText(name, { exact: true })
}

type SurfaceBounds = { left: number; top: number; width: number; height: number }

const mobileEntryInsets = { top: 24, right: 16, bottom: 20, left: 18 }

type SurfaceAnimationRecord = {
  surface: string | null
  duration: number
  viewportWidth: number
  viewportHeight: number
  before: SurfaceBounds
  start: SurfaceBounds
}

type SurfaceFrameRecord = {
  pathname: string
  surface: string | null
  transform: string
  translateX: number
  bounds: SurfaceBounds
  opacity: string
  rows: string[]
  pendingMain: string | null
  treeScope: string | null
}

async function installSurfaceAnimationProbe(page: Page) {
  const channelRowPrefix = tid.channelRow("")
  await page.addInitScript(({ channelRowPrefix }) => {
    const state = window as typeof window & {
      __communitySurfaceAnimations?: SurfaceAnimationRecord[]
      __communitySurfaceFrames?: SurfaceFrameRecord[]
      __communitySurfaceFrameStop?: () => void
    }
    state.__communitySurfaceAnimations = []
    state.__communitySurfaceFrames = []
    const bounds = (element: Element): SurfaceBounds => {
      const { left, top, width, height } = element.getBoundingClientRect()
      return { left, top, width, height }
    }
    const nativeAnimate = Element.prototype.animate
    Element.prototype.animate = function (keyframes, options) {
      const before = this.hasAttribute("data-community-mobile-surface") ? bounds(this) : null
      const animation = nativeAnimate.call(this, keyframes, options)
      if (before) {
        state.__communitySurfaceAnimations!.push({
          surface: this.getAttribute("data-community-mobile-surface"),
          duration: Number(animation.effect!.getTiming().duration),
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          before,
          start: bounds(this),
        })
      }
      return animation
    }
    const probeAnimate = Element.prototype.animate

    let raf = 0
    const sample = () => {
      for (const surface of document.querySelectorAll<HTMLElement>('[data-slot="community-sidebar-panel-content"], [data-slot="community-main-panel-content"]')) {
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
          surface: surface.dataset.slot === "community-sidebar-panel-content" ? "list" : "detail",
          transform: style.transform,
          translateX: style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m41,
          bounds: bounds(surface),
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
    state.__communitySurfaceFrameStop = () => {
      cancelAnimationFrame(raf)
      if (Element.prototype.animate === probeAnimate) Element.prototype.animate = nativeAnimate
    }
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

async function expectDetailEntry(page: Page) {
  const detail = page.locator('[data-community-mobile-surface="detail"]')
  await expect.poll(() => detail.evaluate(element => getComputedStyle(element).transform)).toBe("none")
  const animations = await surfaceAnimations(page)
  expect(animations).toHaveLength(1)
  const entry = animations[0]
  expect(entry.surface).toBe("detail")
  expect(entry.duration).toBe(280)
  const { width, height } = page.viewportSize()!
  expect(entry.viewportWidth).toBe(width)
  expect(entry.viewportHeight).toBe(height)
  const expected = {
    left: mobileEntryInsets.left,
    top: mobileEntryInsets.top,
    width: width - mobileEntryInsets.left - mobileEntryInsets.right,
    height: height - mobileEntryInsets.top - mobileEntryInsets.bottom,
  }
  const settled = await detail.evaluate(element => {
    const { left, top, width, height } = element.getBoundingClientRect()
    return { left, top, width, height }
  })
  for (const edge of ["left", "top", "width", "height"] as const) {
    expect(entry.before[edge]).toBeCloseTo(expected[edge], 0)
    expect(settled[edge]).toBeCloseTo(expected[edge], 0)
    expect(entry.start[edge]).toBeCloseTo(expected[edge] + (edge === "left" ? width : 0), 0)
  }
  const frames = await surfaceFrames(page)
  const listFrames = frames.filter(frame => frame.surface === "list")
  expectStationaryFrames(listFrames)
  for (const frame of listFrames) {
    for (const edge of ["left", "top", "width", "height"] as const) {
      expect(frame.bounds[edge]).toBeCloseTo(listFrames[0].bounds[edge], 0)
    }
  }
  const detailFrames = frames.filter(frame => frame.surface === "detail")
  expect(detailFrames.some(frame => frame.translateX > 0)).toBe(true)
  for (const frame of detailFrames) {
    expect(frame.translateX).toBeGreaterThanOrEqual(-0.5)
    expect(frame.translateX).toBeLessThanOrEqual(width + 0.5)
    expect(frame.opacity).toBe("1")
    expect(frame.bounds.left).toBeCloseTo(expected.left + frame.translateX, 0)
    expect(frame.bounds.top).toBeCloseTo(expected.top, 0)
    expect(frame.bounds.width).toBeCloseTo(expected.width, 0)
    expect(frame.bounds.height).toBeCloseTo(expected.height, 0)
  }
}

test("community checkpoint shows target pending for detail and keeps list surfaces stable", async ({ caseActors, caseResources }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed

  const stamp = Date.now()
  const serverId = await seedServer("alice", `Frame Gate ${stamp}`)
  const channelAName = `frame-a-${stamp}`
  const channelBName = `frame-b-${stamp}`
  const channelA = await seedChannel("alice", serverId, channelAName)
  const channelB = await seedChannel("alice", serverId, channelBName)
  const { page } = await asUser("alice")
  const machineDataGate = await holdRoute(page, "**/api/community/machines**", caseResources)
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

  const leafGate = await holdRoute(page, `**/api/community/channels/${channelB}/messages*`, caseResources)
  await page.getByTestId(tid.channelRow(channelB)).click({ noWaitAfter: true })
  await expect.poll(leafGate.held).toBeGreaterThan(0)
  const pendingMain = page.locator(
    `[data-community-target-href="/c/channels/${serverId}/${channelB}"]`,
  ).locator('main[aria-label="Loading conversation"][aria-busy="true"][data-community-conversation-subtype="text"]').filter({
    has: page.locator('[data-slot="skeleton"]'),
  })
  const targetReady = page.locator(
    `[data-community-target-href="/c/channels/${serverId}/${channelB}"]`,
  ).filter({
    has: page.getByRole("heading", { name: channelBName, exact: true }),
  }).filter({ has: page.locator(
    `[data-slot="community-conversation-surface"][data-channel-id="${channelB}"]`,
  ).filter({ has: page.getByTestId(tid.composerInput) }) })
  const oldMain = page.locator(
    `[data-slot="community-conversation-surface"][data-channel-id="${channelA}"]`,
  )
  await expect(pendingMain.or(targetReady).first()).toBeVisible()
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(channelHeader(page, channelAName)).toHaveCount(0)
  await expect(oldMain).toHaveCount(0)
  await page.waitForTimeout(150)
  await expect(pendingMain.or(targetReady).first()).toBeVisible()
  await expect(channelHeader(page, channelAName)).toHaveCount(0)
  await expect(oldMain).toHaveCount(0)
  await leafGate.release()
  await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })
  await expect(targetReady).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click({ noWaitAfter: true })
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(channelHeader(page, channelBName)).toBeVisible()
  await page.waitForTimeout(150)
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(channelHeader(page, channelBName)).toBeVisible({ timeout: 30_000 })

  await page.goto("/c/me/friends")
  await expect(page.getByPlaceholder("Search friends")).toBeVisible({ timeout: 30_000 })
  await page.getByRole("link", { name: "Machines", exact: true }).click({ noWaitAfter: true })
  await expect.poll(machineDataGate.held).toBeGreaterThan(0)
  await expect(page.getByPlaceholder("Search friends")).toHaveCount(0)
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(page.locator('[data-slot="community-machines-heading"] [data-slot="skeleton"]').first()).toBeVisible()
  await expect(page.getByText("No machines yet", {exact: true})).toHaveCount(0)
  await expect(page.getByTestId(tid.machinePairOpen)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe("/c/me/machines")
  await machineDataGate.release()
  await expect(page.getByText("No machines yet", {exact: true})).toBeVisible()
  await expect(page.getByTestId(tid.machinePairOpen)).toBeEnabled()
  expect(new URL(page.url()).pathname).toBe("/c/me/machines")
  const cachedMachineContent = page.getByText("No machines yet", {exact: true})
  await cachedMachineContent.evaluate(element => { element.setAttribute("data-e2e-cached-identity", "retained") })
  await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")
  await expect(cachedMachineContent).toHaveAttribute("data-e2e-cached-identity", "retained")
  await page.getByRole("link", {name: "Friends", exact: true}).click()
  await expect(page.getByPlaceholder("Search friends")).toBeVisible()
  await page.getByRole("link", {name: "Machines", exact: true}).click({noWaitAfter: true})
  await expect(cachedMachineContent).toBeVisible()
  await expect(page.getByTestId(tid.machinePairOpen)).toBeEnabled()
  await expect(page.getByPlaceholder("Search friends")).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me/machines")

  expect(mutations).toEqual([])
})

test("mobile detail enters once while sidebar identity survives pending and same-server history", async ({ caseActors, caseResources }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed

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
  const previousInsets = await page.evaluate(insets => Object.entries(insets).map(([edge, value]) => {
    const style = document.documentElement.style
    const name = `--app-safe-area-${edge}`
    const previous = { name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) }
    style.setProperty(name, `${value}px`)
    return previous
  }), mobileEntryInsets)
  caseResources.own(previousInsets, async values => {
    if (page.isClosed()) return
    await page.evaluate(previous => {
      const state = window as typeof window & {
        __communitySurfaceAnimations?: SurfaceAnimationRecord[]
        __communitySurfaceFrames?: SurfaceFrameRecord[]
        __communitySurfaceFrameStop?: () => void
      }
      state.__communitySurfaceFrameStop?.()
      delete state.__communitySurfaceAnimations
      delete state.__communitySurfaceFrames
      delete state.__communitySurfaceFrameStop
      const style = document.documentElement.style
      for (const { name, value, priority } of previous) {
        if (value) style.setProperty(name, value, priority)
        else style.removeProperty(name)
      }
    }, values)
  })
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
  await expectDetailEntry(page)
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  expect(await surfaceAnimations(page)).toHaveLength(1)
  expectStationaryFrames((await surfaceFrames(page)).filter(frame => frame.surface === "list"))
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await clearSurfaceAnimations(page)
  const pendingPath = `/c/channels/${serverId}/${pendingChannel}`
  const pendingGate = await holdRoute(page, `**/api/community/channels/${pendingChannel}/messages*`, caseResources)
  await page.getByTestId(tid.channelRow(pendingChannel)).click({ noWaitAfter: true })
  await expect.poll(pendingGate.held).toBeGreaterThan(0)
  const pendingMain = page.locator(
    `[data-community-target-href="${pendingPath}"]`,
  ).locator('main[aria-label="Loading conversation"][aria-busy="true"][data-community-conversation-subtype="text"]').filter({
    has: page.locator('[data-slot="skeleton"]'),
  })
  const targetReady = page.locator(
    `[data-community-target-href="${pendingPath}"]`,
  ).filter({
    has: page.getByRole("heading", { name: pendingName, exact: true }),
  }).filter({ has: page.locator(
    `[data-slot="community-conversation-surface"][data-channel-id="${pendingChannel}"]`,
  ).filter({ has: page.getByTestId(tid.composerInput) }) })
  await expect(pendingMain.or(targetReady).first()).toBeVisible()
  await expect(page.getByLabel("Resolving conversation")).toHaveCount(0)
  await expect(channelHeader(page, fastName)).toHaveCount(0)
  await expect(page.locator(
    `[data-slot="community-conversation-surface"][data-channel-id="${fastChannel}"]`,
  )).toHaveCount(0)
  await pendingGate.release()

  await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible({ timeout: 30_000 })
  await expect(targetReady).toBeVisible()
  await expectDetailEntry(page)
  expect(await sidebarScroll.evaluate((element) => (
    element as typeof element & { __e2eIdentity?: string }
  ).__e2eIdentity)).toBe("stable")
  expect(await fastRow.evaluate((element) => (
    element as typeof element & { __e2eDndOwner?: string }
  ).__e2eDndOwner)).toBe("stable")

  await clearSurfaceAnimations(page)
  await page.goBack()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await expect(fastRow).toBeVisible()
  await page.goForward()
  await expect.poll(() => new URL(page.url()).pathname).toBe(pendingPath)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  await expectDetailEntry(page)

  await clearSurfaceAnimations(page)
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

  await page.setViewportSize({ width: 640, height: 844 })
  await clearSurfaceAnimations(page)
  await fastRow.click()
  await expect(channelHeader(page, fastName)).toBeVisible()
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
  expectStationaryFrames(await surfaceFrames(page))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  expect(await surfaceAnimations(page)).toEqual([])
})
